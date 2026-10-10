// Finance Phase B ledger tests (tenant migration 0085).
//
// Drives orders, payments, refunds, voids, expenses and supplier invoices
// through their normal paths and checks the financial_events journal: the
// right events are posted, balances converge to the source, history is
// immutable, the whole-restaurant totals reconcile with the source tables,
// and only finance users can read or adjust it. Everything runs in one DO
// block that rolls back. Uses the deck's example order (Rs 2,560).
//
// Usage (from apps/api):  npx tsx scripts/test-financial-ledger.ts [project_ref]
import { supabaseAdmin } from '../src/supabase';
import { getFreshConnection } from '../src/lib/supabaseOAuth';
import { env } from '../src/env';

const REF = process.argv[2] ?? 'uhfwoftjecgjemvwqdbp';
// PRE_SQL=<file>: run a migration first inside the same rolled-back transaction (rehearsal).
const PRE = process.env.PRE_SQL ? require('node:fs').readFileSync(process.env.PRE_SQL, 'utf8') + String.fromCharCode(10) : '';

const claims = (sub: string, perms: string[], role = 'staff') =>
  JSON.stringify({ role: 'authenticated', sub, app_metadata: { kind: 'portal', role, permissions: perms } });

const OWNER = claims('00000000-0000-0000-0000-0000000000a1', ['*'], 'owner');
const FINANCE = claims('00000000-0000-0000-0000-0000000000f1', ['finance.view']);
const ADJUSTER = claims('00000000-0000-0000-0000-0000000000f2', ['finance.view', 'finance.adjust_ledger']);
const WAITER = claims('00000000-0000-0000-0000-0000000000b1', ['orders.view', 'orders.create'], 'waiter');

const SQL = String.raw`
do $$
declare res text := ''; fails int := 0; n int; b bigint; b2 bigint; src bigint; led bigint; t text;
  o uuid; o2 uuid; pay public.payments; ex uuid; sup uuid; inv uuid; adj bigint;
begin
  -- ── Order lifecycle: pending → served → refund → paid → void ──
  insert into public.orders (order_number, status, subtotal_cents, total_cents, channel)
    values ((select coalesce(max(order_number), 0) + 1000000 from public.orders), 'pending', 256000, 256000, 'dine_in')
    returning id into o;
  insert into public.order_lines (order_id, name_snapshot, unit_price_cents, qty, line_total_cents, recipe_cost_cents) values
    (o, 'Beef Burger Regular', 75000, 2, 150000, 59700),
    (o, 'Chicken Fries Box', 70000, 1, 70000, 23300),
    (o, 'Coke 500ml', 18000, 2, 36000, 20000);
  select count(*) into n from public.financial_events where order_id = o;
  if n = 0 then res := res || E'PASS L1 an open order posts nothing\n';
  else fails := fails + 1; res := res || format(E'FAIL L1 open order posted %s events\n', n); end if;

  update public.orders set status = 'served' where id = o;
  select coalesce(sum(signed_cents) filter (where category = 'revenue'), 0),
         coalesce(sum(signed_cents) filter (where category = 'cogs'), 0) into b, b2
    from public.financial_events where order_id = o;
  select string_agg(event_type, ',' order by id) into t from public.financial_events where order_id = o;
  if b = 256000 and b2 = 103000 and t = 'ORDER_COMPLETED,COGS_RECORDED' then
    res := res || E'PASS L2 serving the order posts revenue Rs 2,560 and COGS Rs 1,030\n';
  else fails := fails + 1; res := res || format(E'FAIL L2 revenue=%s cogs=%s events=%s\n', b, b2, t); end if;

  update public.orders set refunded_cents = 36000 where id = o;
  select sum(signed_cents) into b from public.financial_events where order_id = o and category = 'revenue';
  select event_type into t from public.financial_events where order_id = o order by id desc limit 1;
  if b = 220000 and t = 'REVENUE_REFUNDED' then res := res || E'PASS L3 a Rs 360 refund reduces revenue to Rs 2,200\n';
  else fails := fails + 1; res := res || format(E'FAIL L3 revenue=%s last=%s\n', b, t); end if;

  update public.orders set status = 'paid', paid_at = now() where id = o;
  select count(*) into n from public.financial_events where order_id = o;
  if n = 3 then res := res || E'PASS L4 served → paid does not count the sale twice\n';
  else fails := fails + 1; res := res || format(E'FAIL L4 %s events after paid\n', n); end if;

  update public.orders set status = 'void' where id = o;
  select coalesce(sum(signed_cents) filter (where category = 'revenue'), 0),
         coalesce(sum(signed_cents) filter (where category = 'cogs'), 0) into b, b2
    from public.financial_events where order_id = o;
  if b = 0 and b2 = 0 then res := res || E'PASS L5 voiding a completed order reverses its revenue and COGS\n';
  else fails := fails + 1; res := res || format(E'FAIL L5 after void revenue=%s cogs=%s\n', b, b2); end if;

  -- ── Payments through the real functions ──
  insert into public.orders (order_number, status, subtotal_cents, total_cents, channel)
    values ((select coalesce(max(order_number), 0) + 1 from public.orders), 'served', 256000, 256000, 'dine_in')
    returning id into o2;
  perform set_config('request.jwt.claims', '${OWNER}', true);
  begin
    pay := public.record_payment(o2, 256000, 'cash', 300000, null);
    perform public.refund_payment(pay.id, 36000, 'QA refund', 'cash');
    select string_agg(event_type, ',' order by id), sum(signed_cents) into t, b
      from public.financial_events where source_table = 'payments' and source_id = pay.id;
    if t = 'PAYMENT_RECEIVED,REFUND_ISSUED' and b = 220000 then
      res := res || E'PASS P1 record_payment + refund_payment post received Rs 2,560 then refund Rs 360\n';
    else fails := fails + 1; res := res || format(E'FAIL P1 events=%s balance=%s\n', t, b); end if;
    pay := public.record_payment(o2, 36000, 'card', null, 'QA-CARD');
    perform public.void_payment(pay.id, 'QA void');
    select string_agg(event_type, ',' order by id), sum(signed_cents) into t, b
      from public.financial_events where source_table = 'payments' and source_id = pay.id;
    if t = 'PAYMENT_RECEIVED,PAYMENT_VOIDED' and b = 0 then
      res := res || E'PASS P2 void_payment posts a void that brings the payment balance to zero\n';
    else fails := fails + 1; res := res || format(E'FAIL P2 events=%s balance=%s\n', t, b); end if;
  exception when others then fails := fails + 1; res := res || 'FAIL P1/P2 ' || sqlerrm || E'\n'; end;

  -- ── Expenses: record, edit, move date, delete ──
  -- Approved straight away (as the database owner) so it is an operating cost; see 0087.
  insert into public.expenses (category, description, amount_cents, expense_date, status)
    values ('Rent', 'QA rent', 500000, current_date - 3, 'approved') returning id into ex;
  update public.expenses set amount_cents = 450000 where id = ex;
  update public.expenses set expense_date = current_date - 1 where id = ex;
  select coalesce(sum(signed_cents) filter (where business_date = current_date - 3), 0),
         coalesce(sum(signed_cents) filter (where business_date = current_date - 1), 0) into b, b2
    from public.financial_events where source_table = 'expenses' and source_id = ex;
  if b = 0 and b2 = 450000 then res := res || E'PASS X1 expense edits post adjustments and a date move re-dates it\n';
  else fails := fails + 1; res := res || format(E'FAIL X1 old-date=%s new-date=%s\n', b, b2); end if;
  delete from public.expenses where id = ex;
  select sum(signed_cents) into b from public.financial_events where source_table = 'expenses' and source_id = ex;
  if b = 0 then res := res || E'PASS X2 deleting an expense posts a reversal, history kept\n';
  else fails := fails + 1; res := res || format(E'FAIL X2 balance after delete=%s\n', b); end if;

  -- ── Payables: approval in, payment out ──
  insert into public.suppliers (name) values ('Royal Meat Traders — QA') returning id into sup;
  insert into public.supplier_invoices (supplier_id, supplier_invoice_number, invoice_date, total_cents)
    values (sup, 'QA-LEDGER-1', current_date, 900000) returning id into inv;
  select count(*) into n from public.financial_events where source_id = inv;
  update public.supplier_invoices set status = 'approved', approved_at = now() where id = inv;
  insert into public.supplier_payments (supplier_id, amount_cents) values (sup, 900000);
  select coalesce(sum(signed_cents), 0) into b from public.financial_events where supplier_id = sup and category = 'payable';
  if n = 0 and b = 0 and exists (select 1 from public.financial_events where source_id = inv and event_type = 'SUPPLIER_INVOICE_APPROVED') then
    res := res || E'PASS S1 only an approved invoice becomes payable; paying it clears the balance\n';
  else fails := fails + 1; res := res || format(E'FAIL S1 pre-approval events=%s balance=%s\n', n, b); end if;

  -- ── Immutability (even for the database owner) ──
  begin
    update public.financial_events set amount_cents = 1 where id = (select max(id) from public.financial_events);
    fails := fails + 1; res := res || E'FAIL I1 a ledger row was edited\n';
  exception when insufficient_privilege then res := res || E'PASS I1 ledger rows cannot be edited\n'; end;
  begin
    delete from public.financial_events where id = (select max(id) from public.financial_events);
    fails := fails + 1; res := res || E'FAIL I2 a ledger row was deleted\n';
  exception when insufficient_privilege then res := res || E'PASS I2 ledger rows cannot be deleted\n'; end;

  -- ── Whole-restaurant reconciliation (source tables vs ledger) ──
  select coalesce(sum(subtotal_cents - discount_cents - refunded_cents), 0) into src from public.orders where status in ('served', 'paid');
  select coalesce(sum(signed_cents), 0) into led from public.financial_events where category = 'revenue' and event_type <> 'MANUAL_ADJUSTMENT';
  if src = led then res := res || format(E'PASS R1 revenue reconciles with orders (%s)\n', led);
  else fails := fails + 1; res := res || format(E'FAIL R1 orders=%s ledger=%s\n', src, led); end if;
  select coalesce(sum(l.recipe_cost_cents), 0) into src from public.order_lines l join public.orders x on x.id = l.order_id where x.status in ('served', 'paid');
  select coalesce(sum(signed_cents), 0) into led from public.financial_events where category = 'cogs' and event_type <> 'MANUAL_ADJUSTMENT';
  if src = led then res := res || format(E'PASS R2 COGS reconciles with recipe costs (%s)\n', led);
  else fails := fails + 1; res := res || format(E'FAIL R2 recipes=%s ledger=%s\n', src, led); end if;
  select coalesce(sum(amount_cents - refunded_cents), 0) into src from public.payments where status <> 'voided';
  select coalesce(sum(signed_cents), 0) into led from public.financial_events where category = 'payment' and event_type <> 'MANUAL_ADJUSTMENT';
  if src = led then res := res || format(E'PASS R3 payments reconcile (%s)\n', led);
  else fails := fails + 1; res := res || format(E'FAIL R3 payments=%s ledger=%s\n', src, led); end if;
  select coalesce(sum(amount_cents), 0) into src from public.expenses where status in ('approved', 'paid');
  select coalesce(sum(signed_cents), 0) into led from public.financial_events where category = 'expense' and event_type <> 'MANUAL_ADJUSTMENT';
  if src = led then res := res || format(E'PASS R4 expenses reconcile (%s)\n', led);
  else fails := fails + 1; res := res || format(E'FAIL R4 expenses=%s ledger=%s\n', src, led); end if;

  -- ── Access ──
  perform set_config('request.jwt.claims', '${WAITER}', true); set local role authenticated;
  select count(*) into n from public.financial_events; reset role;
  if n = 0 then res := res || E'PASS A1 a waiter cannot read the ledger\n';
  else fails := fails + 1; res := res || format(E'FAIL A1 waiter read %s events\n', n); end if;
  perform set_config('request.jwt.claims', '${FINANCE}', true); set local role authenticated;
  select count(*) into n from public.ledger_summary(current_date - 3650, current_date + 1);
  begin
    perform public.post_ledger_adjustment('expense', 1000, 'QA', null);
    reset role; fails := fails + 1; res := res || E'FAIL A2 finance.view posted an adjustment\n';
  exception when insufficient_privilege then reset role;
    if n > 0 then res := res || E'PASS A2 finance.view reads the ledger summary but cannot adjust it\n';
    else fails := fails + 1; res := res || E'FAIL A2 finance.view saw an empty summary\n'; end if;
  end;
  perform set_config('request.jwt.claims', '${ADJUSTER}', true); set local role authenticated;
  begin
    adj := public.post_ledger_adjustment('expense', -1000, 'QA correction of a duplicated receipt', current_date);
    reset role;
    select count(*) into n from public.audit_logs where action = 'ledger.adjusted' and entity_id = adj::text;
    if n = 1 then res := res || E'PASS A3 finance.adjust_ledger posts a reasoned, audited adjustment\n';
    else fails := fails + 1; res := res || E'FAIL A3 adjustment not audited\n'; end if;
  exception when others then reset role; fails := fails + 1; res := res || 'FAIL A3 ' || sqlerrm || E'\n'; end;

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
