// Finance Phase H — one fictional restaurant day, end to end, through the
// real functions with the real role checks, then every finance view is
// checked against every other. One DO block, rolled back.
//
// The day (today, so it lands on the restaurant's own business day):
//   • Table 4 eats Rs 3,000 (food cost Rs 1,100) and pays cash.
//   • A takeaway of Rs 1,500 (food cost Rs 400) pays by card; Rs 500 is refunded.
//   • A cashier pays Rs 200 out of the till for ice.
//   • Staff submit a Rs 800 gas bill; the finance lead approves it; it is paid by bank.
//   • A Rs 5,000 supplier invoice matches its PO and delivery, is approved and paid.
//   • The day is closed with the till counted exactly.
// Everything is measured as a change from the figures before the scenario,
// so the restaurant's real data for today does not disturb it.
//
// Usage (from apps/api):  npx tsx scripts/test-finance-scenario.ts [project_ref]
import { supabaseAdmin } from '../src/supabase';
import { getFreshConnection } from '../src/lib/supabaseOAuth';
import { env } from '../src/env';

const REF = process.argv[2] ?? 'uhfwoftjecgjemvwqdbp';

const claims = (sub: string, perms: string[], role = 'staff') =>
  JSON.stringify({ role: 'authenticated', sub, app_metadata: { kind: 'portal', role, permissions: perms } });

const OWNER = claims('00000000-0000-0000-0000-0000000000a1', ['*'], 'owner');
const CASHIER = claims('00000000-0000-0000-0000-0000000ca5e1', ['payments.view', 'payments.accept', 'payments.refund', 'cash.manage']);
const CLERK = claims('00000000-0000-0000-0000-00000000c1e1', ['finance.view', 'finance.create_expense']);
const APPROVER = claims('00000000-0000-0000-0000-00000000a991', ['finance.view', 'finance.approve_expense', 'invoices.approve', 'invoices.view']);
const PAYER = claims('00000000-0000-0000-0000-00000000fa71', ['finance.view', 'finance.pay_expense', 'payables.record_payment', 'payables.view']);
const PURCHASER = claims('00000000-0000-0000-0000-0000000b0b01', ['purchases.view', 'invoices.view', 'invoices.match']);
const WAITER = claims('00000000-0000-0000-0000-00000000aa17', ['orders.view', 'orders.create'], 'waiter');

const SQL = String.raw`
do $$
declare res text := ''; fails int := 0; n int; b bigint; v_status text; j0 jsonb; j1 jsonb; v_row public.daily_closings;
  d date := app.business_day(now());
  rev0 bigint; cogs0 bigint; pay0 bigint; exp0 bigint; pyb0 bigint; cash0 bigint; pp0 record; pp1 record;
  oa uuid; ob uuid; p public.payments; ex uuid; sup uuid; po uuid; pol uuid; inv uuid; was_closed boolean;
begin
  -- ── Baseline (as the owner, who sees everything) ──
  perform set_config('request.jwt.claims', '${OWNER}', true); set local role authenticated;
  select coalesce(sum(net_cents) filter (where category = 'revenue'), 0), coalesce(sum(net_cents) filter (where category = 'cogs'), 0),
         coalesce(sum(net_cents) filter (where category = 'payment'), 0), coalesce(sum(net_cents) filter (where category = 'expense'), 0),
         coalesce(sum(net_cents) filter (where category = 'payable'), 0)
    into rev0, cogs0, pay0, exp0, pyb0 from public.ledger_summary(d, d);
  select * into pp0 from public.period_profitability(now() - interval '1 minute', now() + interval '1 minute');
  j0 := public.day_close_preview(d, 0);
  reset role;
  was_closed := app.is_day_closed(d);

  -- ── Service: two orders as the floor would create them ──
  insert into public.orders (order_number, status, subtotal_cents, total_cents, channel)
    values ((select coalesce(max(order_number), 0) + 1000000 from public.orders), 'served', 300000, 300000, 'dine_in') returning id into oa;
  insert into public.order_lines (order_id, name_snapshot, unit_price_cents, qty, line_total_cents, recipe_cost_cents) values
    (oa, 'Mixed Grill Platter — QA', 200000, 1, 200000, 80000), (oa, 'Garlic Naan — QA', 25000, 4, 100000, 30000);
  insert into public.orders (order_number, status, subtotal_cents, total_cents, channel)
    values ((select coalesce(max(order_number), 0) + 1 from public.orders), 'served', 150000, 150000, 'takeaway') returning id into ob;
  insert into public.order_lines (order_id, name_snapshot, unit_price_cents, qty, line_total_cents, recipe_cost_cents) values
    (ob, 'Chicken Karahi Half — QA', 150000, 1, 150000, 40000);

  -- ── Cashier takes payment, refunds, pays out ──
  perform set_config('request.jwt.claims', '${CASHIER}', true); set local role authenticated;
  begin
    p := public.record_payment(oa, 300000, 'cash', 300000, null);
    p := public.record_payment(ob, 150000, 'card', null, 'QA-CARD-1');
    perform public.refund_payment(p.id, 50000, 'Wrong side dish — QA', 'card');
    perform public.record_cash_movement(d, 'pay_out', 20000, 'Ice for the cold room — QA', 'receipt QA-7');
    reset role;
  exception when others then reset role; fails := fails + 1; res := res || 'FAIL C0 cashier steps: ' || sqlerrm || E'\n'; end;

  -- ── Expense: submit → approve → pay ──
  perform set_config('request.jwt.claims', '${CLERK}', true); set local role authenticated;
  begin
    insert into public.expenses (category, description, amount_cents, expense_date) values ('Utilities', 'Gas bill — QA', 80000, d) returning id into ex;
    reset role;
  exception when others then reset role; fails := fails + 1; res := res || 'FAIL X0 clerk could not record an expense: ' || sqlerrm || E'\n'; end;
  select coalesce(sum(signed_cents), 0) into b from public.financial_events where source_table = 'expenses' and source_id = ex;
  if ex is not null and b = 0 then res := res || E'PASS X1 a submitted expense is not yet a cost\n';
  else fails := fails + 1; res := res || format(E'FAIL X1 submitted expense posted %s\n', b); end if;
  perform set_config('request.jwt.claims', '${CLERK}', true); set local role authenticated;
  begin
    perform public.approve_expense(ex);
    reset role; fails := fails + 1; res := res || E'FAIL X2 the clerk approved an expense\n';
  exception when insufficient_privilege then reset role; res := res || E'PASS X2 a clerk who can record expenses cannot approve them\n'; end;
  perform set_config('request.jwt.claims', '${APPROVER}', true); set local role authenticated;
  perform public.approve_expense(ex);
  reset role;
  perform set_config('request.jwt.claims', '${PAYER}', true); set local role authenticated;
  perform public.pay_expense(ex, 'bank_transfer', 'QA-BANK-1', d);
  reset role;
  select coalesce(sum(signed_cents), 0), (select status::text from public.expenses where id = ex) into b, v_status
    from public.financial_events where source_table = 'expenses' and source_id = ex;
  if b = 80000 and v_status = 'paid' then res := res || E'PASS X3 approved then paid: the Rs 800 cost is counted once\n';
  else fails := fails + 1; res := res || format(E'FAIL X3 posted=%s status=%s\n', b, v_status); end if;

  -- ── Supplier: PO → delivery → invoice → match → approve → pay ──
  insert into public.suppliers (name) values ('Lahore Fresh Produce — QA') returning id into sup;
  insert into public.purchase_orders (po_number, supplier_id, status) values (990000777, sup, 'sent') returning id into po;
  insert into public.purchase_order_lines (purchase_order_id, description, qty, unit_cost_cents, received_qty)
    values (po, 'Tomatoes (kg)', 25, 20000, 25) returning id into pol;
  insert into public.supplier_invoices (supplier_id, purchase_order_id, supplier_invoice_number, invoice_date, subtotal_cents, total_cents)
    values (sup, po, 'LFP-QA-0091', d, 500000, 500000) returning id into inv;
  insert into public.supplier_invoice_lines (invoice_id, po_line_id, description, qty, unit_cost_cents, line_total_cents)
    values (inv, pol, 'Tomatoes (kg)', 25, 20000, 500000);
  perform set_config('request.jwt.claims', '${PURCHASER}', true); set local role authenticated;
  perform public.match_supplier_invoice(inv);
  reset role;
  select status::text into v_status from public.supplier_invoices where id = inv;
  if v_status = 'matched' then res := res || E'PASS S1 invoice agrees with the PO and the delivery: matched\n';
  else fails := fails + 1; res := res || format(E'FAIL S1 status after match=%s\n', v_status); end if;
  perform set_config('request.jwt.claims', '${PAYER}', true); set local role authenticated;
  begin
    perform public.approve_supplier_invoice(inv);
    reset role; fails := fails + 1; res := res || E'FAIL S2 the payer approved the invoice\n';
  exception when insufficient_privilege then reset role; res := res || E'PASS S2 paying and approving are separate permissions\n'; end;
  perform set_config('request.jwt.claims', '${APPROVER}', true); set local role authenticated;
  perform public.approve_supplier_invoice(inv);
  reset role;
  select coalesce(sum(signed_cents), 0) into b from public.financial_events where supplier_id = sup and category = 'payable';
  if b = 500000 then res := res || E'PASS S3 approval makes Rs 5,000 payable\n';
  else fails := fails + 1; res := res || format(E'FAIL S3 payable=%s\n', b); end if;
  perform set_config('request.jwt.claims', '${PAYER}', true); set local role authenticated;
  perform public.record_supplier_payment(sup, 500000, 'bank_transfer', 'QA-BANK-2',
    jsonb_build_array(jsonb_build_object('invoice_id', inv, 'amount_cents', 500000)));
  select count(*) into n from public.payables_aging() where supplier_id = sup;
  select coalesce(sum(outstanding_cents), 0) into b from public.supplier_payable(sup);
  reset role;
  select status::text into v_status from public.supplier_invoices where id = inv;
  if v_status = 'paid' and b = 0 and n = 0
     and (select coalesce(sum(signed_cents), 0) from public.financial_events where supplier_id = sup and category = 'payable') = 0 then
    res := res || E'PASS S4 paid in full: invoice paid, nothing outstanding, gone from aging, payable balance 0\n';
  else fails := fails + 1; res := res || format(E'FAIL S4 status=%s outstanding=%s aging_rows=%s\n', v_status, b, n); end if;

  -- ── Every view agrees ──
  perform set_config('request.jwt.claims', '${OWNER}', true); set local role authenticated;
  select coalesce(sum(net_cents) filter (where category = 'revenue'), 0) - rev0, coalesce(sum(net_cents) filter (where category = 'cogs'), 0) - cogs0,
         coalesce(sum(net_cents) filter (where category = 'payment'), 0) - pay0, coalesce(sum(net_cents) filter (where category = 'expense'), 0) - exp0,
         coalesce(sum(net_cents) filter (where category = 'payable'), 0) - pyb0
    into rev0, cogs0, pay0, exp0, pyb0 from public.ledger_summary(d, d);
  select * into pp1 from public.period_profitability(now() - interval '1 minute', now() + interval '1 minute');
  j1 := public.day_close_preview(d, 0);
  reset role;

  if rev0 = 400000 and cogs0 = 150000 then
    res := res || E'PASS V1 ledger: sales Rs 4,000 (3,000 + 1,500 − 500 refund), food cost Rs 1,500\n';
  else fails := fails + 1; res := res || format(E'FAIL V1 ledger revenue=%s cogs=%s\n', rev0, cogs0); end if;
  if pp1.net_sales_cents - pp0.net_sales_cents = rev0 and pp1.theoretical_cogs_cents - pp0.theoretical_cogs_cents = cogs0 then
    res := res || E'PASS V2 profit report and ledger give the same sales and food cost\n';
  else fails := fails + 1; res := res || format(E'FAIL V2 profitability net=%s cogs=%s\n',
    pp1.net_sales_cents - pp0.net_sales_cents, pp1.theoretical_cogs_cents - pp0.theoretical_cogs_cents); end if;
  if pay0 = 400000 then res := res || E'PASS V3 customer money held: Rs 4,000 after the refund\n';
  else fails := fails + 1; res := res || format(E'FAIL V3 payments=%s\n', pay0); end if;
  if exp0 = 80000 and pyb0 = 0 then res := res || E'PASS V4 expenses Rs 800; supplier payable back to zero\n';
  else fails := fails + 1; res := res || format(E'FAIL V4 expenses=%s payable=%s\n', exp0, pyb0); end if;
  if (j1->'sales'->>'net_sales_cents')::bigint - (j0->'sales'->>'net_sales_cents')::bigint = rev0
     and coalesce((j1->'payments_by_method'->>'cash')::bigint, 0) - coalesce((j0->'payments_by_method'->>'cash')::bigint, 0) = 300000
     and (j1->'cash'->>'expected_cents')::bigint - (j0->'cash'->>'expected_cents')::bigint = 280000 then
    res := res || E'PASS V5 day close: sales match the ledger; till expects Rs 3,000 cash − Rs 200 pay-out\n';
  else fails := fails + 1; res := res || format(E'FAIL V5 preview before %s after %s\n', left(j0::text, 200), left(j1::text, 300)); end if;
  if rev0 - cogs0 - exp0 = 170000 then
    res := res || E'PASS V6 operating profit for the scenario: 4,000 − 1,500 − 800 = Rs 1,700\n';
  else fails := fails + 1; res := res || format(E'FAIL V6 profit=%s\n', rev0 - cogs0 - exp0); end if;

  -- ── A waiter sees none of it ──
  perform set_config('request.jwt.claims', '${WAITER}', true); set local role authenticated;
  select count(*) into n from public.ledger_summary(d, d);
  select n + count(*) into n from public.financial_events;
  select n + count(*) into n from public.expenses;
  begin perform public.day_close_preview(d, 0); n := n + 1; exception when insufficient_privilege then null; end;
  reset role;
  if n = 0 then res := res || E'PASS W1 a waiter cannot see the ledger, expenses or the day-close preview\n';
  else fails := fails + 1; res := res || format(E'FAIL W1 waiter saw %s finance rows\n', n); end if;

  -- ── Close the day, counted exactly ──
  if was_closed then
    res := res || E'SKIP D1 today was already closed in this restaurant\n';
  else
    perform set_config('request.jwt.claims', '${OWNER}', true); set local role authenticated;
    begin
      v_row := public.close_business_day(d, 0, (j1->'cash'->>'expected_cents')::int, null);
      reset role;
      if v_row.status = 'closed' and v_row.difference_cents = 0 and v_row.cash_movements_cents is not null then
        res := res || E'PASS D1 the day closes with no difference and no reason needed\n';
      else fails := fails + 1; res := res || format(E'FAIL D1 %s\n', row_to_json(v_row)::text); end if;
    exception when others then reset role; fails := fails + 1; res := res || 'FAIL D1 ' || sqlerrm || E'\n'; end;
    perform set_config('request.jwt.claims', '${CASHIER}', true); set local role authenticated;
    begin
      perform public.record_cash_movement(d, 'pay_out', 1000, 'after close — QA');
      reset role; fails := fails + 1; res := res || E'FAIL D2 cash moved on a closed day\n';
    exception when others then reset role; res := res || E'PASS D2 nothing can be added to a closed day\n'; end;
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
