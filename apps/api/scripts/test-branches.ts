// Multi-branch tests (tenant migrations 0098+). One DO block, rolled back.
//
//   B1  existing data belongs to the default (MAIN) branch
//   B2  the owner creates a branch; a waiter cannot
//   B3  a login limited to one branch sees only that branch's orders,
//       payments, ledger, expenses and day closes (and cannot write to another)
//   B4  payments and ledger lines inherit their order's branch
//   B5  the default branch cannot be deactivated; deactivating needs a reason
//   B6  without the multi-branch plan feature, a second active branch is refused
//   B7  a branch-limited manager can only hand out their own branches
//
// Usage (from apps/api):  npx tsx scripts/test-branches.ts [project_ref] [--with-migration <file.sql>]
import fs from 'node:fs';
import { supabaseAdmin } from '../src/supabase';
import { getFreshConnection } from '../src/lib/supabaseOAuth';
import { env } from '../src/env';

const REF = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : 'uhfwoftjecgjemvwqdbp';
const migIdx = process.argv.indexOf('--with-migration');
const PRE = migIdx > 0 ? fs.readFileSync(process.argv[migIdx + 1], 'utf8') + '\n' : '';

const claims = (sub: string, perms: string[], role = 'staff') =>
  JSON.stringify({ role: 'authenticated', sub, app_metadata: { kind: 'portal', role, permissions: perms } });
const OWNER = claims('00000000-0000-0000-0000-0000000000a1', ['*'], 'owner');
const WAITER = claims('00000000-0000-0000-0000-00000000aa17', ['orders.view'], 'waiter');
const DHA_USER = '00000000-0000-0000-0000-00000000d4a1';
const DHA_CASHIER = claims(DHA_USER, ['orders.view', 'orders.create', 'payments.view', 'finance.view', 'branches.manage']);

const SQL = String.raw`
do $$
declare res text := ''; fails int := 0; n int; n2 int; b_main uuid; b_dha public.branches; b_clf public.branches;
  o_main uuid; o_dha uuid; p_dha uuid; portal uuid; v text; tier text; feats text[]; v_uuid uuid; v_uuid2 uuid; v_item uuid; v_mi uuid; v_mv uuid; v_sup uuid; v_po uuid; v_pol uuid;
begin
  b_main := app.default_branch_id();
  select count(*) into n from public.orders where branch_id is distinct from b_main;
  if b_main is not null and n = 0 then res := res || E'PASS B1 every existing order belongs to the default branch\n';
  else fails := fails + 1; res := res || format(E'FAIL B1 default=%s orders elsewhere=%s\n', b_main, n); end if;

  -- B2
  perform set_config('request.jwt.claims', '${OWNER}', true); set local role authenticated;
  b_dha := public.create_branch('DHA-QA', 'DHA — QA', 'Phase 6', 'Karachi', 'Pakistan', 'Asia/Karachi', 'PKR');
  b_clf := public.create_branch('CLF-QA', 'Clifton — QA', null, 'Karachi', 'Pakistan');
  reset role;
  perform set_config('request.jwt.claims', '${WAITER}', true); set local role authenticated;
  begin
    perform public.create_branch('GUL-QA', 'Gulshan — QA');
    reset role; fails := fails + 1; res := res || E'FAIL B2 a waiter created a branch\n';
  exception when insufficient_privilege then reset role;
    if b_dha.code = 'DHA-QA' and b_clf.id is not null then res := res || E'PASS B2 the owner creates branches; a waiter cannot\n';
    else fails := fails + 1; res := res || E'FAIL B2 owner create\n'; end if;
  end;

  -- Orders in two branches (as the database owner, like the server does)
  insert into public.orders (order_number, status, subtotal_cents, total_cents, channel, branch_id)
    values ((select coalesce(max(order_number), 0) + 1000000 from public.orders), 'served', 100000, 100000, 'dine_in', b_main) returning id into o_main;
  insert into public.orders (order_number, status, subtotal_cents, total_cents, channel, branch_id)
    values ((select coalesce(max(order_number), 0) + 1 from public.orders), 'served', 250000, 250000, 'dine_in', b_dha.id) returning id into o_dha;
  insert into public.payments (order_id, amount_cents, method) values (o_dha, 250000, 'cash') returning id into p_dha;

  -- B4
  select count(*) into n from public.payments where id = p_dha and branch_id = b_dha.id;
  select count(*) into n2 from public.financial_events where order_id = o_dha and branch_id is distinct from b_dha.id;
  if n = 1 and n2 = 0 and exists (select 1 from public.financial_events where order_id = o_dha) then
    res := res || E'PASS B4 the payment and every ledger line inherit the order\'s branch\n';
  else fails := fails + 1; res := res || format(E'FAIL B4 payment_in_branch=%s ledger_elsewhere=%s\n', n, n2); end if;

  -- B3: a cashier portal limited to DHA (created by the owner)
  perform set_config('request.jwt.claims', '${OWNER}', true);
  insert into public.portals (name, route_key, permissions, portal_user_id, branch_ids)
    values ('DHA counter — QA', 'dha-qa-' || substr(md5(random()::text), 1, 6), array['orders.view','orders.create','payments.view','finance.view'], '${DHA_USER}', array[b_dha.id])
    returning id into portal;
  perform set_config('request.jwt.claims', '${DHA_CASHIER}', true); set local role authenticated;
  select count(*) into n from public.orders where id in (o_main, o_dha);
  select count(*) into n2 from public.orders where id = o_dha;
  v := (select string_agg(code, ',' order by code) from public.my_branches());
  reset role;
  if n = 1 and n2 = 1 and v = 'DHA-QA' then
    res := res || E'PASS B3 the DHA login sees only DHA\'s order and only DHA in its branch list\n';
  else fails := fails + 1; res := res || format(E'FAIL B3 visible=%s dha=%s branches=%s\n', n, n2, v); end if;
  perform set_config('request.jwt.claims', '${DHA_CASHIER}', true); set local role authenticated;
  select count(*) into n from public.financial_events where branch_id = b_main;
  select n + count(*) into n from public.payments where branch_id = b_main;
  select n + count(*) into n from public.daily_closings where branch_id = b_main;
  begin
    insert into public.expenses (category, description, amount_cents, expense_date, branch_id) values ('Rent', 'QA cross-branch', 100, current_date, b_main);
    n := n + 100;
  exception when insufficient_privilege then null; end;
  reset role;
  if n = 0 then res := res || E'PASS B3b nor MAIN\'s payments, ledger or day closes, and cannot record an expense for MAIN\n';
  else fails := fails + 1; res := res || format(E'FAIL B3b saw or wrote %s MAIN rows\n', n); end if;

  -- B5
  perform set_config('request.jwt.claims', '${OWNER}', true); set local role authenticated;
  n := 0;
  begin perform public.set_branch_status(b_main, 'inactive', 'closing'); exception when check_violation then n := n + 1; end;
  begin perform public.set_branch_status(b_clf.id, 'inactive', ''); exception when check_violation then n := n + 1; end;
  perform public.set_branch_status(b_clf.id, 'inactive', 'Renovation — QA');
  reset role;
  if n = 2 and (select status from public.branches where id = b_clf.id) = 'inactive' then
    res := res || E'PASS B5 the default branch cannot be deactivated; deactivating needs a reason\n';
  else fails := fails + 1; res := res || format(E'FAIL B5 refused=%s\n', n); end if;

  -- B6
  select plan_tier, plan_features into tier, feats from public.business_settings where id = true;
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);  -- the platform's plan sync
  update public.business_settings set plan_tier = 'professional', plan_features = array_remove(coalesce(plan_features, '{}'), 'branches.multi') where id = true;
  perform set_config('request.jwt.claims', '${OWNER}', true); set local role authenticated;
  begin
    perform public.create_branch('GUL-QA', 'Gulshan — QA');
    reset role; fails := fails + 1; res := res || E'FAIL B6 a branch was added without the plan feature\n';
  exception when check_violation then reset role; res := res || E'PASS B6 without multi-branch on the plan, another branch is refused\n'; end;
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  update public.business_settings set plan_tier = tier, plan_features = feats where id = true;

  -- B7
  perform set_config('request.jwt.claims', '${DHA_CASHIER}', true); set local role authenticated;
  begin
    perform public.set_login_branches('portal', portal, array[b_main]);
    reset role; fails := fails + 1; res := res || E'FAIL B7 a DHA login handed out MAIN\n';
  exception when insufficient_privilege then reset role; res := res || E'PASS B7 a branch-limited login can only assign its own branches\n'; end;

  -- ── 0099: the selected branch ──
  if to_regprocedure('app.selected_branch_ids()') is not null then
    perform set_config('request.jwt.claims', '${OWNER}', true);
    -- B8: the header narrows reads, including the definer reporting functions
    perform set_config('request.headers', json_build_object('x-branch-ids', b_dha.id)::text, true);
    set local role authenticated;
    select count(*) into n from public.orders where id in (o_main, o_dha);
    select net_sales_cents into n2 from public.period_profitability(now() - interval '1 minute', now() + interval '1 minute');
    reset role;
    perform set_config('request.headers', '{}', true);
    set local role authenticated;
    select count(*) into v from public.orders where id in (o_main, o_dha);
    reset role;
    if n = 1 and n2 = 250000 and v = '2' then
      res := res || E'PASS B8 selecting DHA narrows lists and the profit report to DHA (Rs 2,500); All shows both\n';
    else fails := fails + 1; res := res || format(E'FAIL B8 dha_rows=%s dha_net=%s all_rows=%s\n', n, n2, v); end if;

    -- B9: a DHA login cannot change a MAIN order through a definer function
    perform set_config('request.jwt.claims', '${DHA_CASHIER}', true); set local role authenticated;
    begin
      update public.orders set customer_name = 'hijack' where id = o_main;
      get diagnostics n = row_count;
      reset role;
      if n = 0 then res := res || E'PASS B9a a DHA login cannot update a MAIN order directly\n';
      else fails := fails + 1; res := res || E'FAIL B9a direct update went through\n'; end if;
    exception when insufficient_privilege then reset role; res := res || E'PASS B9a a DHA login cannot update a MAIN order directly\n'; end;
    perform set_config('request.jwt.claims', '${DHA_CASHIER}', true);
    begin
      update public.orders set customer_name = 'hijack' where id = o_main;   -- as the definer (bypasses RLS)
      fails := fails + 1; res := res || E'FAIL B9b a definer path changed another branch\x27s order\n';
    exception when insufficient_privilege then res := res || E'PASS B9b even a definer function cannot change another branch\x27s order for a DHA login\n'; end;

    -- B10: new rows take the selected branch
    perform set_config('request.jwt.claims', '${OWNER}', true);
    perform set_config('request.headers', json_build_object('x-branch-ids', b_dha.id)::text, true);
    insert into public.table_sessions (table_label) values ('QA-T9') returning branch_id into v_uuid;
    insert into public.orders (order_number, status, subtotal_cents, total_cents, channel)
      values ((select coalesce(max(order_number), 0) + 1 from public.orders), 'pending', 1000, 1000, 'takeaway') returning branch_id into v_uuid2;
    if v_uuid = b_dha.id and v_uuid2 = b_dha.id then res := res || E'PASS B10 a table tab and an order opened while DHA is selected belong to DHA\n';
    else fails := fails + 1; res := res || format(E'FAIL B10 session=%s order=%s\n', v_uuid, v_uuid2); end if;

    -- B11: day close per branch
    perform public.record_cash_movement(current_date - 800, 'pay_out', 5000, 'QA DHA ice');
    perform public.close_business_day(current_date - 800, 10000, 5000, null);   -- float 100 - pay-out 50 = 50 counted
    perform set_config('request.headers', json_build_object('x-branch-ids', b_main)::text, true);
    n := app.day_cash_movements(current_date - 800, b_main);
    if app.is_day_closed(current_date - 800, b_dha.id) and not app.is_day_closed(current_date - 800, b_main) and n = 0 then
      perform public.record_cash_movement(current_date - 800, 'pay_in', 100, 'QA MAIN float');   -- MAIN is still open
      res := res || E'PASS B11 closing DHA\x27s day leaves MAIN open; DHA\x27s pay-out stays in DHA\x27s till\n';
    else fails := fails + 1; res := res || format(E'FAIL B11 dha_closed=%s main_closed=%s main_movements=%s\n',
      app.is_day_closed(current_date - 800, b_dha.id), app.is_day_closed(current_date - 800, b_main), n); end if;

    -- B12: expenses — selected branch, or shared when no branch is selected
    perform set_config('request.headers', json_build_object('x-branch-ids', b_dha.id)::text, true);
    insert into public.expenses (category, description, amount_cents, expense_date, status) values ('Utilities', 'QA DHA gas', 100, current_date, 'approved') returning branch_id into v_uuid;
    perform set_config('request.headers', '{}', true);
    insert into public.expenses (category, description, amount_cents, expense_date, status) values ('Marketing', 'QA brand campaign', 100, current_date, 'approved') returning branch_id into v_uuid2;
    if v_uuid = b_dha.id and v_uuid2 = b_main then res := res || E'PASS B12 an expense recorded in DHA is DHA\x27s; with All selected it goes to the main (head-office) branch\n';
    else fails := fails + 1; res := res || format(E'FAIL B12 dha=%s shared=%s\n', v_uuid, v_uuid2); end if;
    perform set_config('request.headers', '{}', true);
  end if;

  -- ── 0101: stock per branch ──
  if to_regclass('public.branch_stock') is not null then
    perform set_config('request.jwt.claims', '${OWNER}', true);
    perform set_config('request.headers', '{}', true);
    -- B13
    select count(*) into n from public.inventory_items i
     where coalesce(i.stock_qty, 0) <> coalesce((select sum(stock_qty) from public.branch_stock bs where bs.inventory_item_id = i.id), 0);
    if n = 0 then res := res || E'PASS B13 each ingredient\x27s branch stock adds up to its total\n';
    else fails := fails + 1; res := res || format(E'FAIL B13 %s items out of step\n', n); end if;

    -- An ingredient at MAIN, a dish that uses 20 g of it
    insert into public.inventory_items (name, unit, stock_qty, cost_cents_per_base_unit, min_threshold)
      values ('QA Branch Spice', 'g', 100, 10, 5) returning id into v_item;
    insert into public.menu_items (name, price_cents) values ('QA Branch Tikka', 0) returning id into v_mi;
    insert into public.menu_variants (menu_item_id, name, price_cents) values (v_mi, 'Regular', 50000) returning id into v_mv;
    insert into public.recipe_components (menu_item_id, variant_id, inventory_item_id, qty_per_unit) values (v_mi, null, v_item, 20);

    -- B14: transfer 30 g MAIN → DHA
    perform public.transfer_stock(v_item, b_main, b_dha.id, 30, 'QA weekly top-up');
    if app.branch_qty(v_item, b_main) = 70 and app.branch_qty(v_item, b_dha.id) = 30
       and (select stock_qty from public.inventory_items where id = v_item) = 100
       and not exists (select 1 from public.financial_events e join public.stock_ledger s on s.id = e.source_id
                        where s.inventory_item_id = v_item and e.category in ('revenue', 'expense', 'cogs'))
       and coalesce((select sum(e.signed_cents) from public.financial_events e join public.stock_ledger s on s.id = e.source_id
                      where s.inventory_item_id = v_item and s.note like 'Transfer%'), 0) = 0 then
      res := res || E'PASS B14 a transfer moves 30 g MAIN → DHA: total unchanged, no revenue or expense, inventory value nets to zero\n';
    else fails := fails + 1; res := res || format(E'FAIL B14 main=%s dha=%s total=%s\n',
      app.branch_qty(v_item, b_main), app.branch_qty(v_item, b_dha.id), (select stock_qty from public.inventory_items where id = v_item)); end if;

    -- B16: availability per branch (DHA 30 g → 1 dish; MAIN 70 g → 3)
    select floor(producible_qty) into n from public.product_availability where branch_id = b_dha.id and menu_item_id = v_mi limit 1;
    select floor(producible_qty) into n2 from public.product_availability where branch_id = b_main and menu_item_id = v_mi limit 1;
    if n = 1 and n2 = 3 then res := res || E'PASS B16 availability is per branch: DHA can make 1, MAIN 3\n';
    else fails := fails + 1; res := res || format(E'FAIL B16 dha=%s main=%s\n', n, n2); end if;

    -- B15 + B17: a guest at DHA
    perform set_config('request.jwt.claims', '{"role":"anon"}', true);
    perform set_config('request.headers', json_build_object('x-branch-ids', b_dha.id)::text, true);
    begin
      perform public.place_order('takeaway', null, 'QA guest', 0, jsonb_build_array(jsonb_build_object('menu_item_id', v_mi, 'variant_id', v_mv, 'qty', 2)));
      fails := fails + 1; res := res || E'FAIL B17 DHA sold 2 with stock for 1\n';
    exception when check_violation then res := res || E'PASS B17 DHA cannot sell 2 when it can make 1, though MAIN has stock\n'; end;
    perform public.place_order('takeaway', null, 'QA guest', 0, jsonb_build_array(jsonb_build_object('menu_item_id', v_mi, 'variant_id', v_mv, 'qty', 1)));
    perform set_config('request.headers', '{}', true);
    perform set_config('request.jwt.claims', '${OWNER}', true);
    if app.branch_qty(v_item, b_dha.id) = 10 and app.branch_qty(v_item, b_main) = 70 then
      res := res || E'PASS B15 a DHA sale deducts 20 g from DHA only (DHA 10, MAIN 70)\n';
    else fails := fails + 1; res := res || format(E'FAIL B15 dha=%s main=%s\n', app.branch_qty(v_item, b_dha.id), app.branch_qty(v_item, b_main)); end if;

    -- B18: a DHA purchase order received while working in MAIN stocks DHA
    perform set_config('request.headers', json_build_object('x-branch-ids', b_main)::text, true);
    insert into public.suppliers (name) values ('QA Spice Co') returning id into v_sup;
    insert into public.purchase_orders (po_number, supplier_id, status, branch_id, approved_at)
      values ((select coalesce(max(po_number), 0) + 990000 from public.purchase_orders), v_sup, 'sent', b_dha.id, now()) returning id into v_po;
    insert into public.purchase_order_lines (purchase_order_id, inventory_item_id, description, qty, unit_cost_cents)
      values (v_po, v_item, 'QA Spice', 50, 10) returning id into v_pol;
    begin
      perform public.receive_purchase_order_line(v_pol, 50);
      if app.branch_qty(v_item, b_dha.id) = 60 and app.branch_qty(v_item, b_main) = 70 then
        res := res || E'PASS B18 receiving DHA\x27s purchase order adds the 50 g to DHA, even from MAIN\n';
      else fails := fails + 1; res := res || format(E'FAIL B18 dha=%s main=%s\n', app.branch_qty(v_item, b_dha.id), app.branch_qty(v_item, b_main)); end if;
    exception when others then fails := fails + 1; res := res || 'FAIL B18 ' || sqlerrm || E'\n'; end;
    perform set_config('request.headers', '{}', true);
  end if;

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
    console.error(text.slice(0, 2000));
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
