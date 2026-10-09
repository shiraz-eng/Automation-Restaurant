// Finance Phase F tests — cash movements, expected cash, day close and the
// closed-day lock (tenant migration 0092). Uses a business date far in the
// past so it never collides with real closings. One DO block, rolled back.
//
// Usage (from apps/api):  npx tsx scripts/test-day-close.ts [project_ref]
import { supabaseAdmin } from '../src/supabase';
import { getFreshConnection } from '../src/lib/supabaseOAuth';
import { env } from '../src/env';

const REF = process.argv[2] ?? 'uhfwoftjecgjemvwqdbp';

const claims = (sub: string, perms: string[], role = 'staff') =>
  JSON.stringify({ role: 'authenticated', sub, app_metadata: { kind: 'portal', role, permissions: perms } });

const OWNER = claims('00000000-0000-0000-0000-0000000000a1', ['*'], 'owner');
const CASHIER = claims('00000000-0000-0000-0000-0000000ca5e1', ['cash.manage', 'finance.view']);
const WAITER = claims('00000000-0000-0000-0000-00000000aa17', ['orders.view'], 'waiter');

const SQL = String.raw`
do $$
declare res text := ''; fails int := 0; n int; b bigint; j jsonb; v_row public.daily_closings; t text;
  d date := app.business_day(now()) - 700; at timestamptz; o uuid; pay uuid; tz text;
begin
  select coalesce(timezone, 'UTC') into tz from public.business_settings limit 1;
  at := ((d + time '13:00') at time zone coalesce(tz, 'UTC')) + make_interval(mins => coalesce((select business_day_start_minutes from public.business_settings limit 1), 0));

  -- ── Cash movements ──
  perform set_config('request.jwt.claims', '${CASHIER}', true); set local role authenticated;
  perform public.record_cash_movement(d, 'pay_in', 500000, 'Float top-up from safe');
  perform public.record_cash_movement(d, 'pay_out', 150000, 'Ice from corner shop', 'receipt 77');
  perform public.record_cash_movement(d, 'bank_drop', 200000, 'Mid-day bank drop');
  perform public.record_cash_movement(d, 'adjustment', -5000, 'Counterfeit note removed');
  reset role;
  if app.day_cash_movements(d) = 145000 then res := res || E'PASS F1 pay-in, pay-out, bank drop and adjustment net to Rs 1,450\n';
  else fails := fails + 1; res := res || format(E'FAIL F1 movements net %s\n', app.day_cash_movements(d)); end if;

  perform set_config('request.jwt.claims', '${CASHIER}', true); set local role authenticated;
  begin
    perform public.record_cash_movement(d, 'pay_out', 1000, '   ');
    reset role; fails := fails + 1; res := res || E'FAIL F2 movement without a reason\n';
  exception when check_violation then reset role; res := res || E'PASS F2 a movement needs a reason\n'; end;
  perform set_config('request.jwt.claims', '${CASHIER}', true); set local role authenticated;
  begin
    insert into public.cash_movements (business_date, kind, amount_cents, reason) values (d, 'pay_in', 1, 'sneaky');
    reset role; fails := fails + 1; res := res || E'FAIL F3 a movement was inserted directly\n';
  exception when insufficient_privilege then reset role; res := res || E'PASS F3 movements can only be recorded through the function\n'; end;
  perform set_config('request.jwt.claims', '${WAITER}', true); set local role authenticated;
  begin
    perform public.record_cash_movement(d, 'pay_out', 1000, 'taxi');
    reset role; fails := fails + 1; res := res || E'FAIL F4 a waiter recorded a movement\n';
  exception when insufficient_privilege then reset role; res := res || E'PASS F4 a waiter cannot move cash\n'; end;
  begin
    update public.cash_movements set amount_cents = 1 where business_date = d;
    fails := fails + 1; res := res || E'FAIL F5 a movement was edited\n';
  exception when insufficient_privilege then res := res || E'PASS F5 movements are never edited (even by the owner)\n'; end;

  -- ── A sale on that day + preview ──
  insert into public.orders (order_number, status, subtotal_cents, tax_cents, total_cents, channel, created_at, paid_at)
    values ((select coalesce(max(order_number), 0) + 1000000 from public.orders), 'paid', 256000, 0, 256000, 'dine_in', at, at)
    returning id into o;
  insert into public.payments (order_id, amount_cents, method, created_at) values (o, 256000, 'cash', at) returning id into pay;
  perform set_config('request.jwt.claims', '${OWNER}', true);
  j := public.day_close_preview(d, 100000);
  if (j->'sales'->>'net_sales_cents')::int = 256000 and (j->'payments_by_method'->>'cash')::int = 256000
     and (j->'cash'->>'expected_cents')::int = 501000 then
    res := res || E'PASS F6 preview: net sales Rs 2,560, cash Rs 2,560, expected = 1,000 float + 2,560 + 1,450 movements = Rs 5,010\n';
  else fails := fails + 1; res := res || format(E'FAIL F6 preview %s\n', left(j::text, 400)); end if;

  -- ── Close rules ──
  begin
    perform public.close_business_day(d, 100000, 500000, null);
    fails := fails + 1; res := res || E'FAIL F7 closed with an unexplained Rs 10 shortage\n';
  exception when check_violation then res := res || E'PASS F7 a cash difference needs a reason\n'; end;
  v_row := public.close_business_day(d, 100000, 500000, 'Rs 10 short — change given twice');
  if v_row.status = 'closed' and v_row.expected_cash_cents = 501000 and v_row.difference_cents = -1000
     and v_row.cash_movements_cents = 145000 and v_row.summary ? 'payments_by_method' then
    res := res || E'PASS F8 close stores expected, counted, difference, movements and the full summary\n';
  else fails := fails + 1; res := res || format(E'FAIL F8 %s\n', row_to_json(v_row)::text); end if;
  begin
    perform public.close_business_day(d, 0, null, null);
    fails := fails + 1; res := res || E'FAIL F9 a closed day was closed again\n';
  exception when check_violation then res := res || E'PASS F9 a closed day must be reopened before closing again\n'; end;
  begin
    perform public.close_business_day(app.business_day(now()) + 2, 0, null, null);
    fails := fails + 1; res := res || E'FAIL F10 a future day was closed\n';
  exception when check_violation then res := res || E'PASS F10 a future day cannot be closed\n'; end;

  -- ── Locks on the closed day ──
  n := 0;
  begin insert into public.expenses (category, amount_cents, expense_date, status) values ('Other', 100, d, 'approved');
  exception when insufficient_privilege then n := n + 1; end;
  begin update public.payments set amount_cents = 1 where id = pay;
  exception when insufficient_privilege then n := n + 1; end;
  begin update public.payments set status = 'voided' where id = pay;
  exception when insufficient_privilege then n := n + 1; end;
  begin update public.orders set status = 'void' where id = o;
  exception when insufficient_privilege then n := n + 1; end;
  begin update public.orders set discount_cents = 1000 where id = o;
  exception when insufficient_privilege then n := n + 1; end;
  begin perform public.record_cash_movement(d, 'pay_in', 100, 'late float');
  exception when insufficient_privilege then n := n + 1; end;
  begin perform public.record_cash_count(d, 0, 100, null);
  exception when insufficient_privilege then n := n + 1; end;
  if n = 7 then res := res || E'PASS F11 closed day locked: expense, payment edit, void, order void, discount, movement and count all refused\n';
  else fails := fails + 1; res := res || format(E'FAIL F11 only %s of 7 changes were refused\n', n); end if;
  begin
    update public.payments set refunded_cents = 36000, status = 'partially_refunded' where id = pay;
    res := res || E'PASS F12 a refund is still allowed on a closed day''s sale\n';
  exception when others then fails := fails + 1; res := res || 'FAIL F12 ' || sqlerrm || E'\n'; end;

  -- ── Reopen ──
  begin
    perform public.reopen_business_day(d, '');
    fails := fails + 1; res := res || E'FAIL F13 reopened without a reason\n';
  exception when check_violation then res := res || E'PASS F13 reopening needs a reason\n'; end;
  perform public.reopen_business_day(d, 'Supplier bill found for that day');
  begin
    insert into public.expenses (category, amount_cents, expense_date, status) values ('Other', 100, d, 'approved');
    select count(*) into n from public.audit_logs where action = 'day.reopened' and entity_id = d::text;
    if n >= 1 then res := res || E'PASS F14 after an audited reopen the day can be corrected\n';
    else fails := fails + 1; res := res || E'FAIL F14 reopen not audited\n'; end if;
  exception when others then fails := fails + 1; res := res || 'FAIL F14 ' || sqlerrm || E'\n'; end;

  -- ── Ledger ──
  select coalesce(sum(signed_cents), 0), count(*) into b, n from public.financial_events
   where source_table = 'cash_movements' and business_date = d;
  if b = 145000 and n = 4 then res := res || E'PASS F15 every cash movement is in the ledger (net Rs 1,450)\n';
  else fails := fails + 1; res := res || format(E'FAIL F15 ledger %s across %s events\n', b, n); end if;

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
