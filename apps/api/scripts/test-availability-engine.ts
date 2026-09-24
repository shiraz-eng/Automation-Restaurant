// Food availability engine tests (tenant migrations 0052/0054/0060).
//
// Builds a throwaway fixture — Potatoes, Oil, Cheese; French Fries,
// Potato Wedges, Loaded Fries, a Soda with no shared ingredient — inside ONE
// DO block on a real tenant database, runs every scenario against the real
// triggers/RPCs, and ends by raising an exception so the whole transaction
// rolls back: nothing is ever left behind. The repo has no test framework;
// this uses the same Management-API path as apply-tenant-migration.ts.
//
// Usage (from apps/api):
//   npx tsx scripts/test-availability-engine.ts [project_ref]
import { supabaseAdmin } from '../src/supabase';
import { getFreshConnection } from '../src/lib/supabaseOAuth';
import { env } from '../src/env';

const REF = process.argv[2] ?? 'uhfwoftjecgjemvwqdbp';

const SQL = String.raw`
do $$
declare
  res text := '';
  fails int := 0;
  v_potato uuid; v_oil uuid; v_cheese uuid; v_syrup uuid;
  v_fries uuid; v_wedges uuid; v_loaded uuid; v_soda uuid;
  v_q numeric; v_s text; v_q2 numeric; v_q3 numeric; v_t timestamptz; v_order uuid;
  v_prev_setting boolean;
  v_tub uuid; v_ch2 uuid; v_a uuid; v_b uuid; v_c uuid; v_d uuid;
  v_qa numeric; v_qb numeric; v_qc numeric; v_qd numeric;

  -- helpers are inline: qty(item) = producible_qty of the item's base row
begin
  -- Run as a signed-in owner (the RPCs check permissions via the JWT).
  perform set_config('request.jwt.claims',
    '{"role":"authenticated","sub":"00000000-0000-0000-0000-00000000f00d","app_metadata":{"role":"owner","permissions":["*"]}}', true);

  select priority_allocation_enabled into v_prev_setting from public.business_settings where id;
  update public.business_settings set priority_allocation_enabled = false where id;

  -- ── Fixture ──
  insert into public.inventory_items (name, unit, stock_qty, min_threshold) values ('ZZ Potatoes', 'g', 0, 0) returning id into v_potato;
  insert into public.inventory_items (name, unit, stock_qty, min_threshold) values ('ZZ Oil', 'ml', 100000, 0) returning id into v_oil;
  insert into public.inventory_items (name, unit, stock_qty, min_threshold) values ('ZZ Cheese', 'g', 1000, 0) returning id into v_cheese;
  insert into public.inventory_items (name, unit, stock_qty, min_threshold) values ('ZZ Syrup', 'ml', 5000, 0) returning id into v_syrup;
  insert into public.menu_items (name, price_cents, is_available) values ('ZZ French Fries', 300, true) returning id into v_fries;
  insert into public.menu_items (name, price_cents, is_available) values ('ZZ Potato Wedges', 350, true) returning id into v_wedges;
  insert into public.menu_items (name, price_cents, is_available) values ('ZZ Loaded Fries', 500, true) returning id into v_loaded;
  insert into public.menu_items (name, price_cents, is_available) values ('ZZ Soda', 150, true) returning id into v_soda;
  -- Fries: 200 g potato + 20 ml oil. Wedges: 250 g potato + 30 ml oil.
  -- Loaded: 200 g potato + 20 ml oil + 50 g cheese. Soda: 50 ml syrup only.
  insert into public.recipe_components (menu_item_id, inventory_item_id, qty_per_unit) values
    (v_fries, v_potato, 200), (v_fries, v_oil, 20),
    (v_wedges, v_potato, 250), (v_wedges, v_oil, 30),
    (v_loaded, v_potato, 200), (v_loaded, v_oil, 20), (v_loaded, v_cheese, 50),
    (v_soda, v_syrup, 50);

  -- 9. Zero stock → unavailable.
  select status, producible_qty into v_s, v_q from public.product_availability where menu_item_id = v_fries and variant_id is null;
  if v_s = 'unavailable' and v_q = 0 then res := res || E'PASS  9 zero potatoes → French Fries unavailable (0)\n';
  else fails := fails + 1; res := res || format(E'FAIL  9 expected unavailable/0, got %s/%s\n', v_s, v_q); end if;

  -- 1 + 13. Restock → availability rises automatically, no manual step.
  update public.inventory_items set stock_qty = 1000 where id = v_potato;   -- +1 kg
  select status, producible_qty into v_s, v_q from public.product_availability where menu_item_id = v_fries and variant_id is null;
  if v_s <> 'unavailable' and v_q = 5 then res := res || E'PASS  1 restock 1000 g → French Fries 5 available (1000/200)\n';
  else fails := fails + 1; res := res || format(E'FAIL  1 expected 5 available, got %s/%s\n', v_s, v_q); end if;

  -- 3. One-ingredient recipe.
  select producible_qty into v_q from public.product_availability where menu_item_id = v_soda and variant_id is null;
  if v_q = 100 then res := res || E'PASS  3 one-ingredient recipe: Soda 5000/50 = 100\n';
  else fails := fails + 1; res := res || format(E'FAIL  3 expected 100, got %s\n', v_q); end if;

  -- 4 + 5. Multi-ingredient recipe, cheese is the bottleneck.
  select producible_qty, bottleneck_inventory_item_id::text into v_q, v_s from public.product_availability where menu_item_id = v_loaded and variant_id is null;
  if v_q = 5 then res := res || E'PASS  4 multi-ingredient: Loaded Fries = min(1000/200, 100000/20, 1000/50) = 5\n';
  else fails := fails + 1; res := res || format(E'FAIL  4 expected 5, got %s\n', v_q); end if;
  update public.inventory_items set stock_qty = 100 where id = v_cheese;     -- cheese → 2 portions
  select producible_qty, bottleneck_inventory_item_id into v_q, v_order from public.product_availability where menu_item_id = v_loaded and variant_id is null;
  if v_q = 2 and v_order = v_cheese then res := res || E'PASS  5 bottleneck: cheese 100 g → Loaded Fries 2, bottleneck = Cheese\n';
  else fails := fails + 1; res := res || format(E'FAIL  5 expected 2 with cheese bottleneck, got %s\n', v_q); end if;

  -- ── Priority allocation ON: Fries 1st, Wedges 2nd, Loaded 3rd ──
  perform public.set_product_priority(v_fries, 'critical');
  perform public.set_product_priority(v_wedges, 'high');
  perform public.set_product_priority(v_loaded, 'medium');
  update public.inventory_items set stock_qty = 1000 where id = v_cheese;
  perform public.set_priority_level_allocation('[{"priority_level":"critical","allocation_pct":100},{"priority_level":"high","allocation_pct":0},{"priority_level":"medium","allocation_pct":0},{"priority_level":"low","allocation_pct":0}]');
  perform public.set_priority_allocation(true);
  update public.inventory_items set stock_qty = 1100 where id = v_potato;   -- 1100 g potatoes

  -- 6 + 7. Shared ingredient: Fries take floor(1100/200)=5 (1000 g), leaving
  -- 100 g — not enough for one portion of Wedges (250) or Loaded (200).
  select producible_qty into v_q from public.product_availability where menu_item_id = v_fries and variant_id is null;
  select producible_qty into v_q2 from public.product_availability where menu_item_id = v_wedges and variant_id is null;
  select producible_qty into v_q3 from public.product_availability where menu_item_id = v_loaded and variant_id is null;
  if v_q = 5 and v_q2 = 0 and v_q3 = 0 then
    res := res || E'PASS  6/7 shared potatoes 1100 g, priority 1 Fries=5, Wedges=0, Loaded=0 (capacity not double-promised)\n';
  else fails := fails + 1; res := res || format(E'FAIL  6/7 expected 5/0/0, got %s/%s/%s\n', v_q, v_q2, v_q3); end if;

  -- 2. Depletion reduces availability.
  update public.inventory_items set stock_qty = 600 where id = v_potato;
  select producible_qty into v_q from public.product_availability where menu_item_id = v_fries and variant_id is null;
  if v_q = 3 then res := res || E'PASS  2 depletion to 600 g → Fries 3\n';
  else fails := fails + 1; res := res || format(E'FAIL  2 expected 3, got %s\n', v_q); end if;

  -- 8. Priority change reallocates automatically: Wedges above Fries.
  perform public.set_product_priority(v_wedges, 'critical');
  perform public.set_product_priority(v_fries, 'high');
  select producible_qty into v_q from public.product_availability where menu_item_id = v_wedges and variant_id is null;
  select producible_qty into v_q2 from public.product_availability where menu_item_id = v_fries and variant_id is null;
  if v_q = 2 and v_q2 = 0 then res := res || E'PASS  8 priority change → Wedges=2 (500 g), Fries=0 (100 g left), no manual edit\n';
  else fails := fails + 1; res := res || format(E'FAIL  8 expected Wedges 2 / Fries 0, got %s/%s\n', v_q, v_q2); end if;

  -- 15. Unrelated product untouched by a potato change.
  select updated_at into v_t from public.product_availability where menu_item_id = v_soda and variant_id is null;
  update public.inventory_items set stock_qty = 650 where id = v_potato;   -- Wedges 2 (500 g), 150 g left
  if (select updated_at from public.product_availability where menu_item_id = v_soda and variant_id is null) = v_t then
    res := res || E'PASS 15 potato change did not recalculate Soda (no shared ingredient)\n';
  else fails := fails + 1; res := res || E'FAIL 15 Soda was recalculated by a potato change\n'; end if;

  -- 12. A new order can't exceed the allocated quantity. Wedges currently
  -- hold the potatoes (650 g → 2 Wedges, 150 g left); Fries are allocated 0
  -- even though raw stock (650 g) could make 3 on its own.
  insert into public.orders (order_number, channel, status, subtotal_cents, tax_cents, total_cents)
    values (999999, 'takeaway', 'pending', 0, 0, 0) returning id into v_order;
  begin
    insert into public.order_lines (order_id, menu_item_id, name_snapshot, unit_price_cents, qty, line_total_cents)
      values (v_order, v_fries, 'ZZ French Fries', 300, 1, 300);
    fails := fails + 1; res := res || E'FAIL 12 order for Fries accepted though allocated 0\n';
  exception when check_violation then
    res := res || E'PASS 12 order for 1 Fries refused (allocated 0 despite raw stock) — ' || sqlerrm || E'\n';
  end;
  begin
    insert into public.order_lines (order_id, menu_item_id, name_snapshot, unit_price_cents, qty, line_total_cents)
      values (v_order, v_wedges, 'ZZ Potato Wedges', 350, 3, 1050);
    fails := fails + 1; res := res || E'FAIL 12b order for 3 Wedges accepted though only 2 allocated\n';
  exception when check_violation then
    res := res || E'PASS 12b order for 3 Wedges refused (2 allocated)\n';
  end;
  insert into public.order_lines (order_id, menu_item_id, name_snapshot, unit_price_cents, qty, line_total_cents)
    values (v_order, v_wedges, 'ZZ Potato Wedges', 350, 2, 700);
  res := res || E'PASS 12c order for 2 Wedges accepted\n';

  -- 13. Existing accepted order stays intact when stock later hits zero.
  update public.inventory_items set stock_qty = 0 where id = v_potato;
  if (select count(*) from public.order_lines where order_id = v_order) = 1 then
    res := res || E'PASS 13 accepted order line kept after potatoes hit 0\n';
  else fails := fails + 1; res := res || E'FAIL 13 accepted order line changed\n'; end if;

  -- 9b. And everything potato-based is now unavailable.
  if (select bool_and(status = 'unavailable') from public.product_availability
       where menu_item_id in (v_fries, v_wedges, v_loaded) and variant_id is null) then
    res := res || E'PASS 9b potatoes 0 → Fries, Wedges, Loaded all unavailable\n';
  else fails := fails + 1; res := res || E'FAIL 9b not all potato products unavailable\n'; end if;

  -- 13 (acceptance). Restock 50 kg → automatic, priority-ordered.
  update public.inventory_items set stock_qty = 50000 where id = v_potato;
  select producible_qty into v_q from public.product_availability where menu_item_id = v_wedges and variant_id is null;
  select producible_qty into v_q2 from public.product_availability where menu_item_id = v_fries and variant_id is null;
  select producible_qty into v_q3 from public.product_availability where menu_item_id = v_loaded and variant_id is null;
  res := res || format(E'INFO    restock 50 kg → Wedges %s, Fries %s, Loaded %s (oil 100 L; cheese 1 kg)\n', v_q, v_q2, v_q3);
  if v_q > 0 then res := res || E'PASS 13a restock made products available again automatically\n';
  else fails := fails + 1; res := res || E'FAIL 13a restock did not restore availability\n'; end if;

  -- OFF → independent capacity again (each product sees full stock).
  perform public.set_priority_allocation(false);
  select producible_qty into v_q from public.product_availability where menu_item_id = v_fries and variant_id is null;
  if v_q = 250 then res := res || E'PASS 16 allocation OFF → Fries back to independent 50000/200 = 250\n';
  else fails := fails + 1; res := res || format(E'FAIL 16 expected 250, got %s\n', v_q); end if;

  -- ── Priority-level percentages (0062) ──────────────────────────────────
  -- P1–P4. Server-side validation of the total and of each value.
  begin
    perform public.set_priority_level_allocation('[{"priority_level":"critical","allocation_pct":40},{"priority_level":"high","allocation_pct":30},{"priority_level":"medium","allocation_pct":10},{"priority_level":"low","allocation_pct":10}]');
    fails := fails + 1; res := res || E'FAIL P1 total 90% accepted\n';
  exception when check_violation then res := res || E'PASS P1 total 90% refused — ' || sqlerrm || E'\n';
  end;
  begin
    perform public.set_priority_level_allocation('[{"priority_level":"critical","allocation_pct":50},{"priority_level":"high","allocation_pct":30},{"priority_level":"medium","allocation_pct":20},{"priority_level":"low","allocation_pct":10}]');
    fails := fails + 1; res := res || E'FAIL P2 total 110% accepted\n';
  exception when check_violation then res := res || E'PASS P2 total 110% refused\n';
  end;
  begin
    perform public.set_priority_level_allocation('[{"priority_level":"critical","allocation_pct":"-10"},{"priority_level":"high","allocation_pct":50},{"priority_level":"medium","allocation_pct":40},{"priority_level":"low","allocation_pct":20}]');
    fails := fails + 1; res := res || E'FAIL P3 negative percentage accepted\n';
  exception when check_violation then res := res || E'PASS P3 negative percentage refused\n';
  end;
  -- P4. Authorization: a login without availability.update can't change it.
  begin
    perform set_config('request.jwt.claims',
      '{"role":"authenticated","sub":"00000000-0000-0000-0000-00000000beef","app_metadata":{"kind":"portal","portal_id":"11111111-1111-1111-1111-111111111111","permissions":["availability.view"]}}', true);
    perform public.set_priority_level_allocation('[{"priority_level":"critical","allocation_pct":40},{"priority_level":"high","allocation_pct":30},{"priority_level":"medium","allocation_pct":20},{"priority_level":"low","allocation_pct":10}]');
    fails := fails + 1; res := res || E'FAIL P4 availability.view could change percentages\n';
  exception when insufficient_privilege then res := res || E'PASS P4 availability.view alone refused (forbidden)\n';
  end;
  perform set_config('request.jwt.claims',
    '{"role":"authenticated","sub":"00000000-0000-0000-0000-00000000f00d","app_metadata":{"role":"owner","permissions":["*"]}}', true);

  -- Fixture: 10 kg Tubers shared by four dishes, one per level.
  -- A (critical) 200 g · B (high) 250 g · C (medium) 200 g + 50 g Cheese2 · D (low) 100 g.
  perform public.set_priority_allocation(true);
  insert into public.inventory_items (name, unit, stock_qty, min_threshold) values ('ZZ Tubers', 'g', 10000, 0) returning id into v_tub;
  insert into public.inventory_items (name, unit, stock_qty, min_threshold) values ('ZZ Cheese2', 'g', 100000, 0) returning id into v_ch2;
  insert into public.menu_items (name, price_cents, is_available) values ('ZZ A Critical', 100, true) returning id into v_a;
  insert into public.menu_items (name, price_cents, is_available) values ('ZZ B High', 100, true) returning id into v_b;
  insert into public.menu_items (name, price_cents, is_available) values ('ZZ C Medium', 100, true) returning id into v_c;
  insert into public.menu_items (name, price_cents, is_available) values ('ZZ D Low', 100, true) returning id into v_d;
  insert into public.recipe_components (menu_item_id, inventory_item_id, qty_per_unit) values
    (v_a, v_tub, 200), (v_b, v_tub, 250), (v_c, v_tub, 200), (v_c, v_ch2, 50), (v_d, v_tub, 100);
  perform public.set_product_priority(v_a, 'critical');
  perform public.set_product_priority(v_b, 'high');
  perform public.set_product_priority(v_c, 'medium');
  perform public.set_product_priority(v_d, 'low');

  -- P5. Normal allocation 40/30/20/10 of 10 kg: A 4000/200=20, B 3000/250=12, C 2000/200=10, D 1000/100=10.
  perform public.set_priority_level_allocation('[{"priority_level":"critical","allocation_pct":40},{"priority_level":"high","allocation_pct":30},{"priority_level":"medium","allocation_pct":20},{"priority_level":"low","allocation_pct":10}]');
  select producible_qty into v_qa from public.product_availability where menu_item_id = v_a and variant_id is null;
  select producible_qty into v_qb from public.product_availability where menu_item_id = v_b and variant_id is null;
  select producible_qty into v_qc from public.product_availability where menu_item_id = v_c and variant_id is null;
  select producible_qty into v_qd from public.product_availability where menu_item_id = v_d and variant_id is null;
  if (v_qa, v_qb, v_qc, v_qd) = (20::numeric, 12::numeric, 10::numeric, 10::numeric) then
    res := res || E'PASS P5 40/30/20/10 of 10 kg → A 20, B 12, C 10, D 10\n';
  else fails := fails + 1; res := res || format(E'FAIL P5 expected 20/12/10/10, got %s/%s/%s/%s\n', v_qa, v_qb, v_qc, v_qd); end if;

  -- P6. Bottleneck + redistribution: Cheese2 100 g caps C at 2 (uses 400 g of
  -- its 2000 g). The unused 1600 g is split again among levels that can
  -- still use it (40:30:10 → A +4, B +2, D +2), and the last 100 g goes by
  -- priority (D +1): A 24, B 14, C 2, D 13 — all 10 kg used.
  update public.inventory_items set stock_qty = 100 where id = v_ch2;
  select producible_qty into v_qa from public.product_availability where menu_item_id = v_a and variant_id is null;
  select producible_qty into v_qb from public.product_availability where menu_item_id = v_b and variant_id is null;
  select producible_qty into v_qc from public.product_availability where menu_item_id = v_c and variant_id is null;
  select producible_qty into v_qd from public.product_availability where menu_item_id = v_d and variant_id is null;
  if (v_qa, v_qb, v_qc, v_qd) = (24::numeric, 14::numeric, 2::numeric, 13::numeric) then
    res := res || E'PASS P6 cheese bottleneck on C → its unused share redistributed: A 24, B 14, C 2, D 13\n';
  else fails := fails + 1; res := res || format(E'FAIL P6 expected 24/14/2/13, got %s/%s/%s/%s\n', v_qa, v_qb, v_qc, v_qd); end if;
  if v_qc <= 2 then res := res || E'PASS P7 C never shown beyond its recipe capacity (cheese allows 2)\n';
  else fails := fails + 1; res := res || E'FAIL P7 C exceeds recipe capacity\n'; end if;

  -- P8. Depletion with percentages: cheese back, Tubers down to 5 kg → 10/6/5/5.
  update public.inventory_items set stock_qty = 100000 where id = v_ch2;
  update public.inventory_items set stock_qty = 5000 where id = v_tub;
  select producible_qty into v_qa from public.product_availability where menu_item_id = v_a and variant_id is null;
  select producible_qty into v_qb from public.product_availability where menu_item_id = v_b and variant_id is null;
  select producible_qty into v_qc from public.product_availability where menu_item_id = v_c and variant_id is null;
  select producible_qty into v_qd from public.product_availability where menu_item_id = v_d and variant_id is null;
  if (v_qa, v_qb, v_qc, v_qd) = (10::numeric, 6::numeric, 5::numeric, 5::numeric) then
    res := res || E'PASS P8 depletion to 5 kg → A 10, B 6, C 5, D 5\n';
  else fails := fails + 1; res := res || format(E'FAIL P8 expected 10/6/5/5, got %s/%s/%s/%s\n', v_qa, v_qb, v_qc, v_qd); end if;

  -- P9. New order can't exceed D's allocation (5).
  begin
    insert into public.order_lines (order_id, menu_item_id, name_snapshot, unit_price_cents, qty, line_total_cents)
      values (v_order, v_d, 'ZZ D Low', 100, 6, 600);
    fails := fails + 1; res := res || E'FAIL P9 order for 6 D accepted (5 allocated)\n';
  exception when check_violation then res := res || E'PASS P9 order for 6 D refused (5 allocated)\n';
  end;

  -- P10. Restock back to 10 kg → recalculated automatically to 20/12/10/10.
  update public.inventory_items set stock_qty = 10000 where id = v_tub;
  select producible_qty into v_qa from public.product_availability where menu_item_id = v_a and variant_id is null;
  select producible_qty into v_qd from public.product_availability where menu_item_id = v_d and variant_id is null;
  if v_qa = 20 and v_qd = 10 then res := res || E'PASS P10 restock to 10 kg → A 20 … D 10 again, no manual step\n';
  else fails := fails + 1; res := res || format(E'FAIL P10 expected A 20 / D 10, got %s/%s\n', v_qa, v_qd); end if;

  -- P11. Zero-percent levels: 50/50/0/0 → A 25, B 20 use all 10 kg; C, D 0.
  perform public.set_priority_level_allocation('[{"priority_level":"critical","allocation_pct":50},{"priority_level":"high","allocation_pct":50},{"priority_level":"medium","allocation_pct":0},{"priority_level":"low","allocation_pct":0}]');
  select producible_qty into v_qa from public.product_availability where menu_item_id = v_a and variant_id is null;
  select producible_qty into v_qb from public.product_availability where menu_item_id = v_b and variant_id is null;
  select producible_qty into v_qc from public.product_availability where menu_item_id = v_c and variant_id is null;
  select producible_qty into v_qd from public.product_availability where menu_item_id = v_d and variant_id is null;
  if (v_qa, v_qb, v_qc, v_qd) = (25::numeric, 20::numeric, 0::numeric, 0::numeric) then
    res := res || E'PASS P11 50/50/0/0 → A 25, B 20, C 0, D 0 (0% levels get only leftovers)\n';
  else fails := fails + 1; res := res || format(E'FAIL P11 expected 25/20/0/0, got %s/%s/%s/%s\n', v_qa, v_qb, v_qc, v_qd); end if;

  -- P12. Inactive level: High inactive (40/30/20/10) → its 30% goes to the
  -- other active levels (40:20:10 → A 5714g→28, C 2857g→14, D 1428g→14),
  -- then leftovers by priority; B only gets what's left after that.
  perform public.set_priority_level_allocation('[{"priority_level":"critical","allocation_pct":40},{"priority_level":"high","allocation_pct":30,"is_active":false},{"priority_level":"medium","allocation_pct":20},{"priority_level":"low","allocation_pct":10}]');
  select producible_qty into v_qa from public.product_availability where menu_item_id = v_a and variant_id is null;
  select producible_qty into v_qb from public.product_availability where menu_item_id = v_b and variant_id is null;
  select producible_qty into v_qc from public.product_availability where menu_item_id = v_c and variant_id is null;
  select producible_qty into v_qd from public.product_availability where menu_item_id = v_d and variant_id is null;
  if v_qb = 0 and v_qa > 20 and (v_qa * 200 + v_qc * 200 + v_qd * 100) <= 10000 then
    res := res || format(E'PASS P12 High inactive → B %s, others share its 30%%: A %s, C %s, D %s\n', v_qb, v_qa, v_qc, v_qd);
  else fails := fails + 1; res := res || format(E'FAIL P12 got A %s, B %s, C %s, D %s\n', v_qa, v_qb, v_qc, v_qd); end if;

  -- S1. Regression for 0063: app.can_write() used to be NULL for portal
  -- logins, which made  if not (has_perm(x) or can_write())  guards skip.
  begin
    perform set_config('request.jwt.claims',
      '{"role":"authenticated","sub":"00000000-0000-0000-0000-00000000beef","app_metadata":{"kind":"portal","portal_id":"11111111-1111-1111-1111-111111111111","permissions":["purchases.view"]}}', true);
    perform public.approve_purchase_order(gen_random_uuid());
    fails := fails + 1; res := res || E'FAIL S1 portal without purchases.approve got past approve_purchase_order
';
  exception
    when insufficient_privilege then res := res || E'PASS S1 portal without purchases.approve refused by approve_purchase_order
';
    when others then fails := fails + 1; res := res || 'FAIL S1 guard skipped (reached: ' || sqlerrm || E')
';
  end;
  perform set_config('request.jwt.claims',
    '{"role":"authenticated","sub":"00000000-0000-0000-0000-00000000f00d","app_metadata":{"role":"owner","permissions":["*"]}}', true);

  -- 14. Tenant isolation: each restaurant is its own database; the engine
  -- has no restaurant_id input at all, so a client can't aim it elsewhere.
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname in ('app', 'public')
       and p.proname in ('recalc_priority_allocation', 'set_priority_allocation', 'record_dish_waste', 'set_item_available',
                         'set_priority_level_allocation')
       and pg_get_function_arguments(p.oid) ilike '%restaurant%')
  then res := res || E'PASS 14 engine functions take no restaurant/tenant argument (isolation is the database boundary)\n';
  else fails := fails + 1; res := res || E'FAIL 14 an engine function accepts a restaurant id\n'; end if;

  raise exception E'RESULTS (rolled back) — % failed\n%', fails, res;
end $$;
`;

async function main() {
  const { data: proj } = await supabaseAdmin.from('tenant_projects').select('tenant_id').eq('project_ref', REF).single();
  const { data: conns } = await supabaseAdmin.from('supabase_connections').select('tenant_id').eq('tenant_id', proj!.tenant_id);
  const token = conns && conns.length ? (await getFreshConnection(proj!.tenant_id)).access_token : env.SUPABASE_ACCESS_TOKEN;
  const r = await fetch(`https://api.supabase.com/v1/projects/${REF}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: SQL }),
  });
  const text = await r.text();
  const m = text.match(/RESULTS \(rolled back\) — (\d+) failed\\n([\s\S]*?)"}/);
  if (!m) {
    console.error(text);
    process.exitCode = 1;
    return;
  }
  console.log(m[2].replace(/\\n/g, '\n').replace(/\\"/g, '"'));
  console.log(`${m[1]} failed`);
  if (m[1] !== '0') process.exitCode = 1;
}
main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
