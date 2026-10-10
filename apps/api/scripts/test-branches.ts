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
  o_main uuid; o_dha uuid; p_dha uuid; portal uuid; v text; tier text; feats text[]; v_uuid uuid; v_uuid2 uuid;
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
