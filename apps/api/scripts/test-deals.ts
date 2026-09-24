// Deals & Combos rule tests (tenant migration 0064).
//
// Same approach as test-availability-engine.ts: one DO block against a real
// tenant that builds a fixture, exercises the real triggers/RPCs and ends by
// raising an exception so everything rolls back.
//
// Usage (from apps/api):  npx tsx scripts/test-deals.ts [project_ref]
import { supabaseAdmin } from '../src/supabase';
import { getFreshConnection } from '../src/lib/supabaseOAuth';
import { env } from '../src/env';

const REF = process.argv[2] ?? 'uhfwoftjecgjemvwqdbp';

const SQL = String.raw`
do $$
declare
  res text := '';
  fails int := 0;
  v_item uuid; v_ing uuid; v_deal uuid; v_order uuid; v_pos_order uuid;
  v_ok boolean; v_n numeric; v_s text; v_ref text;
begin
  perform set_config('request.jwt.claims',
    '{"role":"authenticated","sub":"00000000-0000-0000-0000-00000000f00d","app_metadata":{"role":"owner","permissions":["*"]}}', true);

  insert into public.inventory_items (name, unit, stock_qty, min_threshold, cost_cents_per_base_unit)
    values ('ZZ Chicken', 'g', 3000, 0, 2) returning id into v_ing;
  insert into public.menu_items (name, price_cents, is_available) values ('ZZ Bucket Piece', 500, true) returning id into v_item;
  insert into public.recipe_components (menu_item_id, inventory_item_id, qty_per_unit) values (v_item, v_ing, 150);

  -- D1. New deal: draft → not available, gets a DEAL- reference.
  insert into public.deals (name, price_cents, status, deal_type) values ('ZZ Family Feast', 1800, 'draft', 'combo')
    returning id, ref_code into v_deal, v_ref;
  insert into public.deal_components (deal_id, menu_item_id, qty) values (v_deal, v_item, 4);
  select is_available into v_ok from public.deals where id = v_deal;
  if v_ok = false and v_ref like 'DEAL-%' then res := res || E'PASS D1 draft is not available, ref ' || v_ref || E'\n';
  else fails := fails + 1; res := res || E'FAIL D1 draft availability/ref\n'; end if;

  -- D2. Publishing through the existing on/off RPC flips status to active.
  perform public.set_deal_available(v_deal, true);
  select status into v_s from public.deals where id = v_deal;
  if v_s = 'active' then res := res || E'PASS D2 set_deal_available(true) → status active\n';
  else fails := fails + 1; res := res || format(E'FAIL D2 status %s\n', v_s); end if;

  -- D3. live_deal_ids respects the sales channel.
  update public.deals set sales_channels = array['pos'] where id = v_deal;
  if not (v_deal = any(public.live_deal_ids('customer_portal'))) and v_deal = any(public.live_deal_ids('pos')) then
    res := res || E'PASS D3 POS-only deal hidden from the customer menu, live at the POS\n';
  else fails := fails + 1; res := res || E'FAIL D3 channel filter\n'; end if;
  update public.deals set sales_channels = array['customer_portal', 'pos'] where id = v_deal;

  -- D4. Deal availability from product_availability: 3000 g / 150 g = 20
  -- pieces; 4 per deal → 5 deals, bottleneck the piece.
  select available_qty, bottleneck_name into v_n, v_s from public.deal_availability() where deal_id = v_deal;
  if v_n = 5 then res := res || format(E'PASS D4 deal availability 5 (20 pieces ÷ 4), bottleneck %s\n', v_s);
  else fails := fails + 1; res := res || format(E'FAIL D4 expected 5, got %s\n', v_n); end if;

  -- D5. Food cost estimate: 4 × 150 g × 2¢ = 1200¢.
  select cost_cents into v_n from public.deal_cost_estimate(jsonb_build_array(jsonb_build_object('menu_item_id', v_item, 'qty', 4)));
  if v_n = 1200 then res := res || E'PASS D5 food cost estimate 1200 (4 × 150 g × 2)\n';
  else fails := fails + 1; res := res || format(E'FAIL D5 expected 1200, got %s\n', v_n); end if;

  -- Orders: one POS takeaway order, one customer-portal dine-in order.
  insert into public.orders (order_number, channel, status, subtotal_cents, tax_cents, total_cents)
    values (999991, 'takeaway', 'pending', 0, 0, 0) returning id into v_pos_order;

  -- D6. Max per order.
  update public.deals set max_qty = 2 where id = v_deal;
  begin
    insert into public.order_lines (order_id, deal_id, name_snapshot, unit_price_cents, qty, line_total_cents)
      values (v_pos_order, v_deal, 'ZZ Family Feast', 1800, 3, 5400);
    fails := fails + 1; res := res || E'FAIL D6 3 accepted with max 2\n';
  exception when check_violation then res := res || E'PASS D6 3 per order refused (max 2) — ' || sqlerrm || E'\n';
  end;
  insert into public.order_lines (order_id, deal_id, name_snapshot, unit_price_cents, qty, line_total_cents)
    values (v_pos_order, v_deal, 'ZZ Family Feast', 1800, 2, 3600);
  res := res || E'PASS D6b 2 per order accepted\n';

  -- D7. Order type: takeaway not offered.
  update public.deals set order_types = array['dine_in'], max_qty = null where id = v_deal;
  begin
    insert into public.order_lines (order_id, deal_id, name_snapshot, unit_price_cents, qty, line_total_cents)
      values (v_pos_order, v_deal, 'ZZ Family Feast', 1800, 1, 1800);
    fails := fails + 1; res := res || E'FAIL D7 takeaway accepted for dine-in-only deal\n';
  exception when check_violation then res := res || E'PASS D7 takeaway order refused for dine-in-only deal\n';
  end;
  update public.deals set order_types = array['dine_in', 'takeaway', 'delivery'] where id = v_deal;

  -- D8. Usage limit counts every non-void order (2 already used).
  update public.deals set usage_limit = 3 where id = v_deal;
  begin
    insert into public.order_lines (order_id, deal_id, name_snapshot, unit_price_cents, qty, line_total_cents)
      values (v_pos_order, v_deal, 'ZZ Family Feast', 1800, 2, 3600);
    fails := fails + 1; res := res || E'FAIL D8 usage limit exceeded\n';
  exception when check_violation then res := res || E'PASS D8 usage limit 3 with 2 used → 2 more refused\n';
  end;

  -- D9. Day-of-week window: a day that isn't today blocks ordering.
  update public.deals set usage_limit = null,
         active_days = array[(extract(dow from (now() at time zone coalesce((select timezone from public.business_settings where id), 'UTC')))::int + 1) % 7]
   where id = v_deal;
  begin
    insert into public.order_lines (order_id, deal_id, name_snapshot, unit_price_cents, qty, line_total_cents)
      values (v_pos_order, v_deal, 'ZZ Family Feast', 1800, 1, 1800);
    fails := fails + 1; res := res || E'FAIL D9 ordered on a day the deal is off\n';
  exception when check_violation then res := res || E'PASS D9 deal refused outside its active days\n';
  end;
  update public.deals set active_days = null where id = v_deal;

  -- D10. Paused deal can't be ordered; existing lines stay.
  perform public.set_deal_available(v_deal, false);
  begin
    insert into public.order_lines (order_id, deal_id, name_snapshot, unit_price_cents, qty, line_total_cents)
      values (v_pos_order, v_deal, 'ZZ Family Feast', 1800, 1, 1800);
    fails := fails + 1; res := res || E'FAIL D10 paused deal ordered\n';
  exception when check_violation then res := res || E'PASS D10 paused deal refused\n';
  end;
  if (select count(*) from public.order_lines where order_id = v_pos_order and deal_id = v_deal) = 1 then
    res := res || E'PASS D11 earlier accepted deal line kept\n';
  else fails := fails + 1; res := res || E'FAIL D11 earlier line changed\n'; end if;

  -- D12. Performance RPC counts the accepted order.
  select orders into v_n from public.deal_performance(now() - interval '1 day', now() + interval '1 minute') where deal_id = v_deal;
  if v_n = 1 then res := res || E'PASS D12 deal_performance counts 1 order\n';
  else fails := fails + 1; res := res || format(E'FAIL D12 expected 1 order, got %s\n', v_n); end if;

  -- D13. A portal without deals.view can't read performance.
  begin
    perform set_config('request.jwt.claims',
      '{"role":"authenticated","sub":"00000000-0000-0000-0000-00000000beef","app_metadata":{"kind":"portal","portal_id":"11111111-1111-1111-1111-111111111111","permissions":["orders.view"]}}', true);
    perform * from public.deal_performance(now() - interval '1 day', now());
    fails := fails + 1; res := res || E'FAIL D13 deal_performance readable without deals.view\n';
  exception when insufficient_privilege then res := res || E'PASS D13 deal_performance refused without deals.view\n';
  end;

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
    console.error(text.slice(0, 1500));
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
