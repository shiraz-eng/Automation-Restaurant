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

  -- 14. Tenant isolation: each restaurant is its own database; the engine
  -- has no restaurant_id input at all, so a client can't aim it elsewhere.
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname in ('app', 'public')
       and p.proname in ('recalc_priority_allocation', 'set_priority_allocation', 'record_dish_waste', 'set_item_available')
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
