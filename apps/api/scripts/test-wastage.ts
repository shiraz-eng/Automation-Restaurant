// Wastage management (tenant migration 0109). One DO block, rolled back.
//
//   W1  a manager's entry (entered in kg) deducts stock once, in base units, at cost
//   W2  the same request sent again returns the first entry — no second deduction
//   W3  waste larger than the stock is refused and leaves nothing behind
//   W4  kitchen staff entries wait for approval; staff can't approve; approval deducts once
//   W5  reversal puts stock back once; finance nets the waste to zero
//   W6  a login without waste permissions can't record
//   W7  a login limited to another branch can't record here or read these entries
//   W8  waste of food an order already used is never deducted again, and is capped
//   W9  the report: net waste, cost only with inventory.view_cost
//   W10 the Inventory screen's record_ingredient_waste still works and creates an entry
//   W11 an unknown unit and a missing "other" note are refused
//
// Usage (from apps/api):  npx tsx scripts/test-wastage.ts [project_ref] [--with-migration <file.sql>]
import fs from 'node:fs';
import { supabaseAdmin } from '../src/supabase';
import { getFreshConnection } from '../src/lib/supabaseOAuth';
import { env } from '../src/env';

const REF = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : 'uhfwoftjecgjemvwqdbp';
const migIdx = process.argv.indexOf('--with-migration');
const PRE = migIdx > 0 ? fs.readFileSync(process.argv[migIdx + 1], 'utf8') + '\n' : '';

const claims = (sub: string, perms: string[], role = 'staff') =>
  JSON.stringify({ role: 'authenticated', sub, app_metadata: { kind: 'portal', role, permissions: perms } });
const MANAGER = claims('00000000-0000-0000-0000-00000000b0a1', ['stock.view', 'stock.history', 'inventory.manage_waste', 'inventory.view_cost'], 'manager');
const COOK = claims('00000000-0000-0000-0000-00000000c00c', ['kitchen.view', 'kitchen.record_waste'], 'chef');
const WAITER = claims('00000000-0000-0000-0000-00000000aa17', ['orders.view'], 'waiter');
const VIEWER = claims('00000000-0000-0000-0000-00000000f1e1', ['stock.view', 'stock.history'], 'staff');
const OTHER_USER = '00000000-0000-0000-0000-00000000e7e1';
const OTHER_BRANCH = claims(OTHER_USER, ['stock.view', 'stock.history', 'inventory.manage_waste']);
const OWNER = claims('00000000-0000-0000-0000-0000000000a1', ['*'], 'owner');

const SQL = String.raw`
do $$
declare res text := ''; fails int := 0; n int; n2 int; item uuid; b_main uuid; b_other public.branches; r jsonb; e1 uuid; e2 uuid;
  v numeric; v2 numeric; err text; req uuid := gen_random_uuid(); rep jsonb; ord record; s bigint;
begin
  b_main := app.default_branch_id();
  insert into public.inventory_items (name, unit, unit_kind, purchase_unit_label, purchase_unit_to_base, cost_cents_per_base_unit, stock_qty)
    values ('QA Waste Chicken', 'g', 'weight', 'KG bag', 1000, 2, 5000) returning id into item;   -- 2 cents per gram

  -- W1
  perform set_config('request.jwt.claims', '${MANAGER}', true); set local role authenticated;
  r := public.record_waste_entry(item, 1, 'kg', 'expiry', 'walk-in', null, null, null, req);
  reset role;
  e1 := (r->>'id')::uuid;
  select count(*) into n from public.stock_ledger where inventory_item_id = item and reason = 'spoilage';
  if r->>'status' = 'approved' and (r->>'qty_base')::numeric = 1000 and (r->>'cost_cents')::bigint = 2000
     and app.branch_qty(item, b_main) = 4000 and n = 1 then
    res := res || E'PASS W1 1 kg recorded as 1000 g, approved at once, stock 5000 → 4000, cost 20.00, one ledger row\n';
  else fails := fails + 1; res := res || format(E'FAIL W1 %s stock=%s rows=%s\n', r, app.branch_qty(item, b_main), n); end if;

  -- W2
  perform set_config('request.jwt.claims', '${MANAGER}', true); set local role authenticated;
  r := public.record_waste_entry(item, 1, 'kg', 'expiry', 'walk-in', null, null, null, req);
  reset role;
  select count(*) into n from public.waste_entries where inventory_item_id = item;
  select count(*) into n2 from public.stock_ledger where inventory_item_id = item and reason = 'spoilage';
  if (r->>'duplicate')::boolean and (r->>'id')::uuid = e1 and n = 1 and n2 = 1 and app.branch_qty(item, b_main) = 4000 then
    res := res || E'PASS W2 a repeated request returns the first entry; stock still 4000\n';
  else fails := fails + 1; res := res || format(E'FAIL W2 dup=%s entries=%s rows=%s\n', r->>'duplicate', n, n2); end if;

  -- W3
  err := null;
  perform set_config('request.jwt.claims', '${MANAGER}', true); set local role authenticated;
  begin
    perform public.record_waste_entry(item, 4001, 'g', 'spillage');
  exception when others then err := sqlerrm; end;
  reset role;
  select count(*) into n from public.waste_entries where inventory_item_id = item;
  if err like 'insufficient_stock%' and n = 1 and app.branch_qty(item, b_main) = 4000 then
    res := res || E'PASS W3 waste above stock is refused (no negative stock, no entry left)\n';
  else fails := fails + 1; res := res || format(E'FAIL W3 err=%s entries=%s\n', err, n); end if;

  -- W4
  perform set_config('request.jwt.claims', '${COOK}', true); set local role authenticated;
  r := public.record_waste_entry(item, 500, 'g', 'cooking_error', 'burnt batch');
  e2 := (r->>'id')::uuid;
  err := null;
  begin perform public.approve_waste_entry(e2); exception when others then err := sqlerrm; end;
  reset role;
  v := app.branch_qty(item, b_main);
  perform set_config('request.jwt.claims', '${MANAGER}', true); set local role authenticated;
  r := public.approve_waste_entry(e2, 'checked');
  reset role;
  v2 := app.branch_qty(item, b_main);
  perform set_config('request.jwt.claims', '${MANAGER}', true); set local role authenticated;
  begin perform public.approve_waste_entry(e2); exception when others then err := err || ' / ' || sqlerrm; end;
  reset role;
  if v = 4000 and err like 'forbidden / waste_entry_already_approved' and r->>'status' = 'approved' and v2 = 3500
     and app.branch_qty(item, b_main) = 3500 then
    res := res || E'PASS W4 kitchen entry waits (stock 4000), cook cannot approve, approval deducts once (3500), second approval refused\n';
  else fails := fails + 1; res := res || format(E'FAIL W4 before=%s after=%s err=%s now=%s\n', v, v2, err, app.branch_qty(item, b_main)); end if;

  -- W5
  perform set_config('request.jwt.claims', '${MANAGER}', true); set local role authenticated;
  r := public.reverse_waste_entry(e2, 'was not burnt');
  err := null;
  begin perform public.reverse_waste_entry(e2, 'again'); exception when others then err := sqlerrm; end;
  reset role;
  select coalesce(sum(f.sign * f.amount_cents), 0) into s from public.financial_events f
    join public.stock_ledger l on l.id = f.source_id
   where f.source_table = 'stock_ledger' and l.id in (select stock_ledger_id from public.waste_entries where id = e2
                                                     union select reversal_ledger_id from public.waste_entries where id = e2);
  if r->>'status' = 'reversed' and app.branch_qty(item, b_main) = 4000 and err = 'waste_entry_not_reversible' and s = 0 then
    res := res || E'PASS W5 reversal restores 500 g once (4000); second reversal refused; finance nets to 0\n';
  else fails := fails + 1; res := res || format(E'FAIL W5 status=%s stock=%s err=%s finance=%s\n', r->>'status', app.branch_qty(item, b_main), err, s); end if;

  -- W6
  err := null;
  perform set_config('request.jwt.claims', '${WAITER}', true); set local role authenticated;
  begin perform public.record_waste_entry(item, 1, 'g', 'spillage'); exception when others then err := sqlerrm; end;
  select count(*) into n from public.waste_entries;
  reset role;
  if err = 'forbidden' and n = 0 then res := res || E'PASS W6 a waiter can neither record nor read waste\n';
  else fails := fails + 1; res := res || format(E'FAIL W6 err=%s visible=%s\n', err, n); end if;

  -- W7
  if not coalesce((select 'branches.multi' = any(coalesce(plan_features, '{}')) from public.business_settings where id = true), false) then
    update public.business_settings set plan_features = array_append(coalesce(plan_features, '{}'), 'branches.multi') where id = true;
  end if;
  perform set_config('request.jwt.claims', '${OWNER}', true);
  b_other := public.create_branch('WQA-' || substr(md5(random()::text), 1, 4), 'Waste QA branch');
  insert into public.portals (name, route_key, permissions, portal_user_id, branch_ids)
    values ('Waste QA', 'waste-qa-' || substr(md5(random()::text), 1, 6), array['stock.view','stock.history','inventory.manage_waste'], '${OTHER_USER}', array[b_other.id]);
  err := null;
  perform set_config('request.jwt.claims', '${OTHER_BRANCH}', true); set local role authenticated;
  begin perform public.record_waste_entry(item, 1, 'g', 'spillage', null, null, null, null, null, b_main); exception when others then err := sqlerrm; end;
  select count(*) into n from public.waste_entries where inventory_item_id = item;
  reset role;
  if err = 'forbidden' and n = 0 then res := res || E'PASS W7 a login limited to another branch cannot record here or see these entries\n';
  else fails := fails + 1; res := res || format(E'FAIL W7 err=%s visible=%s\n', err, n); end if;

  -- W8: an ingredient an existing order already used
  select l.order_id, l.inventory_item_id, -sum(l.delta_qty) as used into ord
    from public.stock_ledger l where l.reason = 'order_deduction' and l.order_id is not null
   group by 1, 2 having -sum(l.delta_qty) > 0 limit 1;
  if ord.order_id is null then
    res := res || E'SKIP W8 no order with recipe deductions in this restaurant\n';
  else
    v := app.branch_qty(ord.inventory_item_id, (select branch_id from public.orders where id = ord.order_id));
    select count(*) into n from public.stock_ledger;
    perform set_config('request.jwt.claims', '${MANAGER}', true); set local role authenticated;
    r := public.record_waste_entry(ord.inventory_item_id, ord.used, null, 'cooking_error', 'sent back', null, null, ord.order_id,
                                   null, (select branch_id from public.orders where id = ord.order_id));
    err := null;
    begin perform public.record_waste_entry(ord.inventory_item_id, 0.001, null, 'cooking_error', null, null, null, ord.order_id,
                                           null, (select branch_id from public.orders where id = ord.order_id));
    exception when others then err := sqlerrm; end;
    reset role;
    select count(*) into n2 from public.stock_ledger;
    if r->>'status' = 'approved' and (r->>'already_consumed')::boolean and r->>'stock_ledger_id' is null and n2 = n
       and app.branch_qty(ord.inventory_item_id, (select branch_id from public.orders where id = ord.order_id)) = v
       and err = 'exceeds_order_usage' then
      res := res || E'PASS W8 waste of food an order used: recorded, no second deduction, capped at what the order used\n';
    else fails := fails + 1; res := res || format(E'FAIL W8 r=%s ledger %s→%s err=%s\n', r, n, n2, err); end if;
  end if;

  -- W9
  perform set_config('request.jwt.claims', '${MANAGER}', true); set local role authenticated;
  rep := public.wastage_report(app.business_day(now()) - 1, app.business_day(now()), b_main);
  reset role;
  select x into r from jsonb_array_elements(rep->'items') x where x->>'inventory_item_id' = item::text;
  perform set_config('request.jwt.claims', '${VIEWER}', true); set local role authenticated;
  rep := public.wastage_report(app.business_day(now()) - 1, app.business_day(now()), b_main);
  reset role;
  if (r->>'waste_qty')::numeric = 1000 and (r->>'waste_cost_cents')::numeric = 2000 and (r->>'closing_qty')::numeric = 4000
     and (r->>'opening_qty')::numeric = 5000 and (r->>'adjust_in_qty')::numeric = 0
     and (select (x->>'waste_cost_cents') is null from jsonb_array_elements(rep->'items') x where x->>'inventory_item_id' = item::text)
     and rep->>'costs_visible' = 'false' then
    res := res || E'PASS W9 report: 1000 g wasted net of the reversal, cost 20.00; no cost for a login without inventory.view_cost\n';
  else fails := fails + 1; res := res || format(E'FAIL W9 manager row=%s viewer costs=%s\n', r, rep->>'costs_visible'); end if;

  -- W10
  perform set_config('request.jwt.claims', '${MANAGER}', true); set local role authenticated;
  v := public.record_ingredient_waste(item, 250, 'dropped tray');
  reset role;
  select count(*) into n from public.waste_entries where inventory_item_id = item and reason = 'spoilage' and note = 'dropped tray' and status = 'approved';
  if v = 3750 and n = 1 then res := res || E'PASS W10 record_ingredient_waste still deducts (3750) and creates a spoilage entry\n';
  else fails := fails + 1; res := res || format(E'FAIL W10 stock=%s entries=%s\n', v, n); end if;

  -- W11
  err := null;
  perform set_config('request.jwt.claims', '${MANAGER}', true); set local role authenticated;
  begin perform public.record_waste_entry(item, 1, 'ml', 'spillage'); exception when others then err := sqlerrm; end;
  begin perform public.record_waste_entry(item, 1, 'g', 'other', '  '); exception when others then err := err || ' / ' || sqlerrm; end;
  reset role;
  if err = 'bad_unit / reason_required' then res := res || E'PASS W11 ml for a gram item and "other" without a note are refused\n';
  else fails := fails + 1; res := res || format(E'FAIL W11 err=%s\n', err); end if;

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
    body: JSON.stringify({ query: PRE + SQL }),
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
