// Finance Phase D matching / rejection / history tests (tenant migration 0089).
//
// The QA scenario from the finance brief (FreshMeat Traders, PO-2024-00123:
// 200 kg chicken ordered at Rs 850, 195 kg received, invoice SI-2024-00456
// bills 200 kg at Rs 900) must raise BOTH a quantity and a price exception
// and stay unapproved. Also covers total arithmetic, missing PO, missing
// goods receipt, double billing, supplier mismatch, a clean match,
// rejection (incl. taking an approved invoice back out of payables), the
// history trail and the guard on the new columns. One DO block, rolled back.
//
// Usage (from apps/api):  npx tsx scripts/test-invoice-matching.ts [project_ref]
import { supabaseAdmin } from '../src/supabase';
import { getFreshConnection } from '../src/lib/supabaseOAuth';
import { env } from '../src/env';

const REF = process.argv[2] ?? 'uhfwoftjecgjemvwqdbp';
// PRE_SQL=<file>: run a migration first inside the same rolled-back transaction (rehearsal).
const PRE = process.env.PRE_SQL ? require('node:fs').readFileSync(process.env.PRE_SQL, 'utf8') + String.fromCharCode(10) : '';

const claims = (sub: string, perms: string[], role = 'staff') =>
  JSON.stringify({ role: 'authenticated', sub, app_metadata: { kind: 'portal', role, permissions: perms } });

const MATCHER = claims('00000000-0000-0000-0000-00000000a7c4', ['invoices.match', 'invoices.view']);
const APPROVER = claims('00000000-0000-0000-0000-00000000a99e', ['invoices.approve', 'invoices.view']);
const CLERK = claims('00000000-0000-0000-0000-0000000c1e4c', ['invoices.create', 'invoices.view']);
const WAITER = claims('00000000-0000-0000-0000-00000000aa17', ['orders.view'], 'waiter');

const SQL = String.raw`
do $$
declare res text := ''; fails int := 0; n int; b bigint; t text; j jsonb; v_status text;
  sup uuid; sup2 uuid; po uuid; pol uuid; po2 uuid; pol2 uuid; pol3 uuid; po_other uuid; pol_other uuid;
  inv uuid; inv_tot uuid; inv_nopo uuid; inv_nogrn uuid; inv_ok uuid; inv_dup uuid; inv_sup uuid;
begin
  insert into public.suppliers (name) values ('FreshMeat Traders (Pvt) Ltd — QA') returning id into sup;
  insert into public.suppliers (name) values ('Other Supplier — QA') returning id into sup2;
  insert into public.purchase_orders (po_number, supplier_id, status) values (990000123, sup, 'sent') returning id into po;
  insert into public.purchase_order_lines (purchase_order_id, description, qty, unit_cost_cents, received_qty)
    values (po, 'Chicken (kg)', 200, 85000, 195) returning id into pol;
  insert into public.purchase_orders (po_number, supplier_id, status) values (990000124, sup, 'sent') returning id into po2;
  insert into public.purchase_order_lines (purchase_order_id, description, qty, unit_cost_cents, received_qty)
    values (po2, 'Beef (kg)', 50, 150000, 50) returning id into pol2;
  insert into public.purchase_order_lines (purchase_order_id, description, qty, unit_cost_cents, received_qty)
    values (po2, 'Mayo (kg)', 10, 65000, 0) returning id into pol3;
  insert into public.purchase_orders (po_number, supplier_id, status) values (990000125, sup2, 'sent') returning id into po_other;
  insert into public.purchase_order_lines (purchase_order_id, description, qty, unit_cost_cents, received_qty)
    values (po_other, 'Oil (L)', 20, 75000, 20) returning id into pol_other;

  -- QA scenario invoice
  insert into public.supplier_invoices (supplier_id, purchase_order_id, supplier_invoice_number, invoice_date, subtotal_cents, total_cents)
    values (sup, po, 'SI-2024-00456', current_date, 18000000, 18000000) returning id into inv;
  insert into public.supplier_invoice_lines (invoice_id, po_line_id, description, qty, unit_cost_cents, line_total_cents)
    values (inv, pol, 'Chicken (kg)', 200, 90000, 18000000);
  -- Clean invoice for the beef line
  insert into public.supplier_invoices (supplier_id, purchase_order_id, supplier_invoice_number, invoice_date, subtotal_cents, tax_cents, total_cents)
    values (sup, po2, 'QA-CLEAN', current_date, 7500000, 120000, 7620000) returning id into inv_ok;
  insert into public.supplier_invoice_lines (invoice_id, po_line_id, description, qty, unit_cost_cents, line_total_cents)
    values (inv_ok, pol2, 'Beef (kg)', 50, 150000, 7500000);
  -- Total doesn't add up
  insert into public.supplier_invoices (supplier_id, supplier_invoice_number, invoice_date, subtotal_cents, total_cents)
    values (sup, 'QA-TOTAL', current_date, 7500000, 7900000) returning id into inv_tot;
  insert into public.supplier_invoice_lines (invoice_id, po_line_id, description, qty, unit_cost_cents, line_total_cents)
    values (inv_tot, pol2, 'Beef (kg)', 1, 150000, 150000);
  -- No PO link
  insert into public.supplier_invoices (supplier_id, supplier_invoice_number, invoice_date, subtotal_cents, total_cents)
    values (sup, 'QA-NOPO', current_date, 5000, 5000) returning id into inv_nopo;
  insert into public.supplier_invoice_lines (invoice_id, description, qty, unit_cost_cents, line_total_cents)
    values (inv_nopo, 'Ice', 1, 5000, 5000);
  -- Nothing received
  insert into public.supplier_invoices (supplier_id, purchase_order_id, supplier_invoice_number, invoice_date, subtotal_cents, total_cents)
    values (sup, po2, 'QA-NOGRN', current_date, 650000, 650000) returning id into inv_nogrn;
  insert into public.supplier_invoice_lines (invoice_id, po_line_id, description, qty, unit_cost_cents, line_total_cents)
    values (inv_nogrn, pol3, 'Mayo (kg)', 10, 65000, 650000);
  -- Line from another supplier's PO
  insert into public.supplier_invoices (supplier_id, supplier_invoice_number, invoice_date, subtotal_cents, total_cents)
    values (sup, 'QA-SUP', current_date, 1500000, 1500000) returning id into inv_sup;
  insert into public.supplier_invoice_lines (invoice_id, po_line_id, description, qty, unit_cost_cents, line_total_cents)
    values (inv_sup, pol_other, 'Oil (L)', 20, 75000, 1500000);

  perform set_config('request.jwt.claims', '${MATCHER}', true); set local role authenticated;
  j := public.match_supplier_invoice(inv);
  perform public.match_supplier_invoice(inv_ok);
  perform public.match_supplier_invoice(inv_tot);
  perform public.match_supplier_invoice(inv_nopo);
  perform public.match_supplier_invoice(inv_nogrn);
  perform public.match_supplier_invoice(inv_sup);
  reset role;
  -- A second invoice for the same 50 kg of beef arrives after QA-CLEAN was matched
  insert into public.supplier_invoices (supplier_id, purchase_order_id, supplier_invoice_number, invoice_date, subtotal_cents, total_cents)
    values (sup, po2, 'QA-DUP', current_date, 7500000, 7500000) returning id into inv_dup;
  insert into public.supplier_invoice_lines (invoice_id, po_line_id, description, qty, unit_cost_cents, line_total_cents)
    values (inv_dup, pol2, 'Beef (kg)', 50, 150000, 7500000);
  perform set_config('request.jwt.claims', '${MATCHER}', true); set local role authenticated;
  perform public.match_supplier_invoice(inv_dup);
  reset role;

  select string_agg(kind, ',' order by kind) into t from public.supplier_payment_holds where invoice_id = inv and status = 'open';
  select status::text into v_status from public.supplier_invoices where id = inv;
  if t = 'price,quantity' and v_status = 'on_hold' and (j->>'matched')::boolean = false then
    res := res || E'PASS M1 QA invoice: quantity (200 billed vs 195 received) AND price (900 vs 850) both flagged, on hold\n';
  else fails := fails + 1; res := res || format(E'FAIL M1 holds=%s status=%s\n', t, v_status); end if;

  select status::text into v_status from public.supplier_invoices where id = inv_ok;
  select count(*) into n from public.supplier_payment_holds where invoice_id = inv_ok and status = 'open';
  if v_status = 'matched' and n = 0 then res := res || E'PASS M2 a correct invoice (with tax) matches cleanly\n';
  else fails := fails + 1; res := res || format(E'FAIL M2 status=%s holds=%s\n', v_status, n); end if;

  for t, inv in select k, i from (values ('total', inv_tot), ('missing_po', inv_nopo), ('missing_grn', inv_nogrn),
                                         ('duplicate', inv_dup), ('supplier', inv_sup)) x(k, i) loop
    select count(*) into n from public.supplier_payment_holds h where h.invoice_id = inv and h.status = 'open' and h.kind = t;
    if n >= 1 then res := res || format(E'PASS M3 %s exception raised\n', t);
    else fails := fails + 1; res := res || format(E'FAIL M3 no %s exception\n', t); end if;
  end loop;
  select id into inv from public.supplier_invoices where supplier_invoice_number = 'SI-2024-00456' and supplier_id = sup;

  -- The new columns can't be forged by the app
  perform set_config('request.jwt.claims', '${CLERK}', true); set local role authenticated;
  begin
    update public.supplier_invoices set match_result = '{"matched":true}' where id = inv;
    reset role; fails := fails + 1; res := res || E'FAIL M4 clerk forged a match result\n';
  exception when insufficient_privilege then reset role; res := res || E'PASS M4 match results cannot be edited directly\n'; end;

  -- Approve the clean one, then reject it: payable goes in, then back out
  perform set_config('request.jwt.claims', '${APPROVER}', true); set local role authenticated;
  perform public.approve_supplier_invoice(inv_ok);
  begin
    perform public.reject_supplier_invoice(inv_ok, '  ');
    reset role; fails := fails + 1; res := res || E'FAIL R1 rejected without a reason\n';
  exception when check_violation then reset role; res := res || E'PASS R1 rejecting needs a reason\n'; end;
  perform set_config('request.jwt.claims', '${APPROVER}', true); set local role authenticated;
  perform public.reject_supplier_invoice(inv_ok, 'Supplier sent the wrong tax rate');
  reset role;
  select status::text into v_status from public.supplier_invoices where id = inv_ok;
  select coalesce(sum(signed_cents), 0), string_agg(event_type, ',' order by id) into b, t
    from public.financial_events where source_table = 'supplier_invoices' and source_id = inv_ok;
  if v_status = 'cancelled' and b = 0 and t = 'SUPPLIER_INVOICE_APPROVED,SUPPLIER_INVOICE_REVERSED' then
    res := res || E'PASS R2 rejecting an approved invoice cancels it and takes it back out of payables\n';
  else fails := fails + 1; res := res || format(E'FAIL R2 status=%s payable=%s events=%s\n', v_status, b, t); end if;

  perform set_config('request.jwt.claims', '${MATCHER}', true); set local role authenticated;
  begin
    perform public.reject_supplier_invoice(inv, 'not mine to reject');
    reset role; fails := fails + 1; res := res || E'FAIL R3 a matcher rejected an invoice\n';
  exception when insufficient_privilege then reset role; res := res || E'PASS R3 only approvers can reject\n'; end;

  -- A paid invoice cannot be rejected
  update public.supplier_invoices set status = 'received' where id = inv_dup;
  delete from public.supplier_invoice_lines where invoice_id = inv_dup;
  insert into public.supplier_invoice_lines (invoice_id, po_line_id, description, qty, unit_cost_cents, line_total_cents)
    values (inv_dup, pol2, 'Beef (kg)', 50, 150000, 7500000);
  update public.supplier_invoices set status = 'approved', approved_at = now() where id = inv_dup;
  perform set_config('request.jwt.claims', '${APPROVER}', true);
  insert into public.supplier_payments (supplier_id, amount_cents) values (sup, 100000) returning id into po2;
  insert into public.supplier_payment_allocations (payment_id, invoice_id, amount_cents) values (po2, inv_dup, 100000);
  set local role authenticated;
  begin
    perform public.reject_supplier_invoice(inv_dup, 'too late');
    reset role; fails := fails + 1; res := res || E'FAIL R4 a part-paid invoice was rejected\n';
  exception when check_violation then reset role; res := res || E'PASS R4 an invoice with payments cannot be rejected\n'; end;

  -- History
  perform set_config('request.jwt.claims', '${MATCHER}', true); set local role authenticated;
  select string_agg(distinct kind, ',' order by kind) into t from public.supplier_invoice_history(inv_ok);
  reset role;
  if t like '%created%' and t like '%matched%' and t like '%approved%' and t like '%rejected%' then
    res := res || format(E'PASS H1 history shows the invoice trail (%s)\n', t);
  else fails := fails + 1; res := res || format(E'FAIL H1 history kinds=%s\n', t); end if;
  perform set_config('request.jwt.claims', '${WAITER}', true); set local role authenticated;
  begin
    perform * from public.supplier_invoice_history(inv_ok);
    reset role; fails := fails + 1; res := res || E'FAIL H2 a waiter read invoice history\n';
  exception when insufficient_privilege then reset role; res := res || E'PASS H2 a waiter cannot read invoice history\n'; end;

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
