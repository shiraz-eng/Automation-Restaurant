// Finance Phase C expense workflow tests (tenant migration 0087).
//
// Walks expenses through draft → submitted → approved → paid → void (and
// the reject / resubmit path) as different portal users, checking the
// permission boundaries, that profit and the ledger move only when an
// expense is approved, and that approved/paid expenses are locked. One DO
// block, always rolled back.
//
// Usage (from apps/api):  npx tsx scripts/test-expense-workflow.ts [project_ref]
import { supabaseAdmin } from '../src/supabase';
import { getFreshConnection } from '../src/lib/supabaseOAuth';
import { env } from '../src/env';

const REF = process.argv[2] ?? 'uhfwoftjecgjemvwqdbp';

const claims = (sub: string, perms: string[], role = 'staff') =>
  JSON.stringify({ role: 'authenticated', sub, app_metadata: { kind: 'portal', role, permissions: perms } });

const OWNER = claims('00000000-0000-0000-0000-0000000000a1', ['*'], 'owner');
const CLERK = claims('00000000-0000-0000-0000-0000000e0c1e', ['finance.view', 'finance.create_expense', 'finance.update_expense', 'finance.delete_expense']);
const APPROVER = claims('00000000-0000-0000-0000-0000000e0a99', ['finance.view', 'finance.approve_expense']);
const PAYER = claims('00000000-0000-0000-0000-0000000e0ba1', ['finance.view', 'finance.pay_expense']);
const WAITER = claims('00000000-0000-0000-0000-0000000000b1', ['orders.view'], 'waiter');

const SQL = String.raw`
do $$
declare res text := ''; fails int := 0; n int; b bigint; base bigint; now_exp bigint; v_status text; v_by uuid;
  ex uuid; ex2 uuid; dr uuid; src bigint; led bigint; t text;
begin
  select count(*) into n from public.expenses where status <> 'paid';
  if n = 0 then res := res || E'PASS C0 every existing expense was kept as paid (profit unchanged)\n';
  else fails := fails + 1; res := res || format(E'FAIL C0 %s existing expenses are not paid\n', n); end if;

  perform set_config('request.jwt.claims', '${OWNER}', true);
  select expenses_cents into base from public.period_profitability(now() - interval '30 days', now());

  -- ── Clerk records an expense ──
  perform set_config('request.jwt.claims', '${CLERK}', true); set local role authenticated;
  insert into public.expenses (category, description, amount_cents, expense_date, status)
    values ('Utilities', 'QA electricity bill', 500000, current_date, 'submitted') returning id into ex;
  begin
    insert into public.expenses (category, amount_cents, expense_date, status) values ('Rent', 100, current_date, 'approved');
    reset role; fails := fails + 1; res := res || E'FAIL C1 clerk created an already-approved expense\n';
  exception when insufficient_privilege then reset role; res := res || E'PASS C1 a new expense cannot start as approved\n'; end;
  select status, submitted_by into v_status, v_by from public.expenses where id = ex;
  select count(*) into n from public.financial_events where source_table = 'expenses' and source_id = ex;
  perform set_config('request.jwt.claims', '${OWNER}', true);
  select expenses_cents into now_exp from public.period_profitability(now() - interval '30 days', now());
  if v_status = 'submitted' and v_by = '00000000-0000-0000-0000-0000000e0c1e' and n = 0 and now_exp = base then
    res := res || E'PASS C2 a submitted expense records who submitted it but does not touch profit or the ledger\n';
  else fails := fails + 1; res := res || format(E'FAIL C2 status=%s by=%s events=%s profit %s→%s\n', v_status, v_by, n, base, now_exp); end if;

  perform set_config('request.jwt.claims', '${CLERK}', true); set local role authenticated;
  begin
    update public.expenses set status = 'approved' where id = ex;
    reset role; fails := fails + 1; res := res || E'FAIL C3 clerk approved by editing the row\n';
  exception when insufficient_privilege then reset role; res := res || E'PASS C3 status cannot be changed by editing the row\n'; end;
  perform set_config('request.jwt.claims', '${CLERK}', true); set local role authenticated;
  update public.expenses set amount_cents = 450000 where id = ex;
  begin
    perform public.approve_expense(ex);
    reset role; fails := fails + 1; res := res || E'FAIL C4 clerk approved their own expense\n';
  exception when insufficient_privilege then reset role;
    res := res || E'PASS C4 clerk can correct a submitted expense but cannot approve it\n'; end;

  -- ── Approver approves → profit and ledger move ──
  perform set_config('request.jwt.claims', '${APPROVER}', true); set local role authenticated;
  perform public.approve_expense(ex); reset role;
  select sum(signed_cents), string_agg(event_type, ',') into b, t from public.financial_events where source_table = 'expenses' and source_id = ex;
  perform set_config('request.jwt.claims', '${OWNER}', true);
  select expenses_cents into now_exp from public.period_profitability(now() - interval '30 days', now());
  if b = 450000 and t = 'EXPENSE_APPROVED' and now_exp = base + 450000 then
    res := res || E'PASS C5 approval posts Rs 4,500 to the ledger and to profit\n';
  else fails := fails + 1; res := res || format(E'FAIL C5 ledger=%s (%s) profit %s→%s\n', b, t, base, now_exp); end if;

  perform set_config('request.jwt.claims', '${CLERK}', true); set local role authenticated;
  begin
    update public.expenses set amount_cents = 1 where id = ex;
    reset role; fails := fails + 1; res := res || E'FAIL C6 an approved expense was edited\n';
  exception when insufficient_privilege then reset role; res := res || E'PASS C6 an approved expense cannot be edited\n'; end;
  perform set_config('request.jwt.claims', '${CLERK}', true); set local role authenticated;
  begin
    delete from public.expenses where id = ex;
    reset role; fails := fails + 1; res := res || E'FAIL C7 an approved expense was deleted\n';
  exception when insufficient_privilege then reset role; res := res || E'PASS C7 an approved expense cannot be deleted\n'; end;

  -- ── Payer pays ──
  perform set_config('request.jwt.claims', '${APPROVER}', true); set local role authenticated;
  begin
    perform public.pay_expense(ex, 'bank_transfer', 'QA-TRX-1');
    reset role; fails := fails + 1; res := res || E'FAIL C8 approver paid without pay permission\n';
  exception when insufficient_privilege then reset role; res := res || E'PASS C8 approving and paying are separate permissions\n'; end;
  perform set_config('request.jwt.claims', '${PAYER}', true); set local role authenticated;
  perform public.pay_expense(ex, 'bank_transfer', 'QA-TRX-1'); reset role;
  select status, paid_by into v_status, v_by from public.expenses where id = ex;
  select sum(signed_cents) into b from public.financial_events where source_table = 'expenses' and source_id = ex;
  select count(*) into n from public.financial_events where source_id = ex and event_type = 'EXPENSE_PAID' and payment_method = 'bank_transfer';
  if v_status = 'paid' and v_by = '00000000-0000-0000-0000-0000000e0ba1' and b = 450000 and n = 1 then
    res := res || E'PASS C9 payment records method, reference and payer without counting the cost twice\n';
  else fails := fails + 1; res := res || format(E'FAIL C9 status=%s by=%s balance=%s paid-events=%s\n', v_status, v_by, b, n); end if;

  -- ── Void a paid expense ──
  perform set_config('request.jwt.claims', '${APPROVER}', true); set local role authenticated;
  begin
    perform public.void_expense(ex, '');
    reset role; fails := fails + 1; res := res || E'FAIL C10 voided without a reason\n';
  exception when check_violation then reset role; res := res || E'PASS C10 voiding needs a reason\n'; end;
  perform set_config('request.jwt.claims', '${APPROVER}', true); set local role authenticated;
  perform public.void_expense(ex, 'QA duplicate bill'); reset role;
  select sum(signed_cents) into b from public.financial_events where source_table = 'expenses' and source_id = ex;
  perform set_config('request.jwt.claims', '${OWNER}', true);
  select expenses_cents into now_exp from public.period_profitability(now() - interval '30 days', now());
  if b = 0 and now_exp = base then res := res || E'PASS C11 voiding reverses the ledger entry and restores profit\n';
  else fails := fails + 1; res := res || format(E'FAIL C11 ledger=%s profit %s→%s\n', b, base, now_exp); end if;

  -- ── Reject and resubmit ──
  perform set_config('request.jwt.claims', '${CLERK}', true); set local role authenticated;
  insert into public.expenses (category, amount_cents, expense_date) values ('Marketing', 200000, current_date) returning id into ex2;
  reset role;
  perform set_config('request.jwt.claims', '${APPROVER}', true); set local role authenticated;
  perform public.reject_expense(ex2, 'Missing receipt'); reset role;
  perform set_config('request.jwt.claims', '${CLERK}', true); set local role authenticated;
  update public.expenses set description = 'Flyers — receipt attached' where id = ex2;
  perform public.submit_expense(ex2); reset role;
  select status into v_status from public.expenses where id = ex2;
  select count(*) into n from public.financial_events where source_id = ex2;
  if v_status = 'submitted' and n = 0 then res := res || E'PASS C12 a rejected expense can be fixed and resubmitted, never posted\n';
  else fails := fails + 1; res := res || format(E'FAIL C12 status=%s events=%s\n', v_status, n); end if;

  -- ── Drafts can be deleted ──
  perform set_config('request.jwt.claims', '${CLERK}', true); set local role authenticated;
  insert into public.expenses (category, amount_cents, expense_date, status) values ('Other', 100, current_date, 'draft') returning id into dr;
  delete from public.expenses where id = dr; reset role;
  select count(*) into n from public.expenses where id = dr;
  if n = 0 then res := res || E'PASS C13 a draft can be deleted\n';
  else fails := fails + 1; res := res || E'FAIL C13 draft was not deleted\n'; end if;

  -- ── Waiter ──
  perform set_config('request.jwt.claims', '${WAITER}', true); set local role authenticated;
  select count(*) into n from public.expenses; reset role;
  if n = 0 then res := res || E'PASS C14 a waiter cannot see expenses\n';
  else fails := fails + 1; res := res || format(E'FAIL C14 waiter saw %s expenses\n', n); end if;

  -- ── Reconciliation + audit ──
  select coalesce(sum(amount_cents), 0) into src from public.expenses where status in ('approved', 'paid');
  select coalesce(sum(signed_cents), 0) into led from public.financial_events where category = 'expense' and event_type <> 'MANUAL_ADJUSTMENT';
  if src = led then res := res || format(E'PASS C15 ledger expenses = approved + paid expenses (%s)\n', led);
  else fails := fails + 1; res := res || format(E'FAIL C15 expenses=%s ledger=%s\n', src, led); end if;
  select count(distinct action) into n from public.audit_logs
   where entity_id in (ex::text, ex2::text) and action in ('expense.approved', 'expense.paid', 'expense.voided', 'expense.rejected', 'expense.submitted');
  if n = 5 then res := res || E'PASS C16 approve, pay, void, reject and submit are all in the audit log\n';
  else fails := fails + 1; res := res || format(E'FAIL C16 only %s workflow actions audited\n', n); end if;

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
