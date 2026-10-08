// Finance Phase A access tests (tenant migration 0083).
//
// Runs as different portal users (role switched to 'authenticated', exactly
// like a PostgREST request) inside one DO block that always rolls back, so no
// data or accounts are left behind. Uses the fictional QA scenario: 200 kg
// chicken ordered at Rs 850, 195 kg received, invoiced 200 kg at Rs 900.
//
// Usage (from apps/api):  npx tsx scripts/test-finance-hardening.ts [project_ref]
import { supabaseAdmin } from '../src/supabase';
import { getFreshConnection } from '../src/lib/supabaseOAuth';
import { env } from '../src/env';

const REF = process.argv[2] ?? 'uhfwoftjecgjemvwqdbp';

const claims = (sub: string, perms: string[], role = 'staff') =>
  JSON.stringify({ role: 'authenticated', sub, app_metadata: { kind: 'portal', role, permissions: perms } });

const CLERK = claims('00000000-0000-0000-0000-0000000c1e4c', ['invoices.create', 'invoices.view']);
const MATCHER = claims('00000000-0000-0000-0000-00000000a7c4', ['invoices.match', 'invoices.view']);
const APPROVER = claims('00000000-0000-0000-0000-00000000a99e', ['invoices.approve', 'invoices.view']);
const PAYER = claims('00000000-0000-0000-0000-00000000ba1e', ['payables.record_payment', 'payables.manage', 'payables.view']);
const WAITER = claims('00000000-0000-0000-0000-00000000aa17', ['orders.view', 'orders.create'], 'waiter');

const SQL = String.raw`
do $$
declare res text := ''; fails int := 0; n int; v_status text; v_by uuid; j jsonb;
  sup uuid; po uuid; pol uuid; inv uuid; inv_ok uuid; inv_paid uuid; pay uuid; hold uuid; line uuid;
begin
  -- Fixtures (as the database owner)
  insert into public.suppliers (name) values ('FreshMeat Traders (Pvt) Ltd — QA') returning id into sup;
  insert into public.purchase_orders (po_number, supplier_id, status) values (990000123, sup, 'sent') returning id into po;
  insert into public.purchase_order_lines (purchase_order_id, description, qty, unit_cost_cents, received_qty)
    values (po, 'Chicken (kg)', 200, 85000, 195) returning id into pol;
  insert into public.supplier_invoices (supplier_id, purchase_order_id, supplier_invoice_number, invoice_date, subtotal_cents, total_cents)
    values (sup, po, 'SI-2024-00456-QA', current_date, 18000000, 18000000) returning id into inv;
  insert into public.supplier_invoice_lines (invoice_id, po_line_id, description, qty, unit_cost_cents, line_total_cents)
    values (inv, pol, 'Chicken (kg)', 200, 90000, 18000000) returning id into line;
  insert into public.supplier_invoices (supplier_id, supplier_invoice_number, invoice_date, total_cents, status)
    values (sup, 'QA-MATCHED', current_date, 50000, 'matched') returning id into inv_ok;
  insert into public.supplier_invoices (supplier_id, supplier_invoice_number, invoice_date, total_cents, status)
    values (sup, 'QA-APPROVED', current_date, 70000, 'approved') returning id into inv_paid;
  insert into public.supplier_payments (supplier_id, amount_cents) values (sup, 1000) returning id into pay;
  insert into public.supplier_payment_holds (invoice_id, reason, amount_cents) values (inv_ok, 'QA hold', 0) returning id into hold;
  update public.supplier_payment_holds set status = 'resolved' where id = hold;

  -- ── Clerk: invoices.create only ──
  perform set_config('request.jwt.claims', '${CLERK}', true); set local role authenticated;
  begin
    update public.supplier_invoices set status = 'approved' where id = inv;
    fails := fails + 1; res := res || E'FAIL A1 clerk set an invoice to approved directly\n';
  exception when insufficient_privilege then res := res || E'PASS A1 clerk cannot approve an invoice by editing it\n'; end;
  begin
    insert into public.supplier_invoices (supplier_id, supplier_invoice_number, invoice_date, total_cents, status)
      values (sup, 'QA-SNEAKY', current_date, 100, 'paid');
    fails := fails + 1; res := res || E'FAIL A2 clerk inserted an invoice already marked paid\n';
  exception when insufficient_privilege then res := res || E'PASS A2 clerk cannot create an invoice as paid\n'; end;
  begin
    perform public.approve_supplier_invoice(inv_ok);
    fails := fails + 1; res := res || E'FAIL A3 clerk approved an invoice\n';
  exception when insufficient_privilege then res := res || E'PASS A3 clerk cannot call approve\n'; end;
  begin
    update public.supplier_invoices set total_cents = 1 where id = inv_paid;
    fails := fails + 1; res := res || E'FAIL A4 clerk edited an approved invoice total\n';
  exception when insufficient_privilege then res := res || E'PASS A4 approved invoice amounts are locked\n'; end;
  begin
    delete from public.supplier_invoices where id = inv_paid;
    fails := fails + 1; res := res || E'FAIL A5 clerk deleted an approved invoice\n';
  exception when insufficient_privilege then res := res || E'PASS A5 approved invoice cannot be deleted\n'; end;
  begin
    insert into public.supplier_invoices (supplier_id, supplier_invoice_number, invoice_date)
      values (sup, 'QA-NEW', current_date);
    update public.supplier_invoices set subtotal_cents = 500, total_cents = 500 where supplier_invoice_number = 'QA-NEW';
    res := res || E'PASS A6 clerk can still create an invoice and set its totals (Purchasing screen flow)\n';
  exception when others then fails := fails + 1; res := res || 'FAIL A6 ' || sqlerrm || E'\n'; end;
  reset role;

  -- ── Matcher: invoices.match runs the 3-way match but cannot approve ──
  perform set_config('request.jwt.claims', '${MATCHER}', true); set local role authenticated;
  begin
    j := public.match_supplier_invoice(inv);
    select status::text into v_status from public.supplier_invoices where id = inv;
    select count(*) into n from public.supplier_payment_holds where invoice_id = inv and status = 'open' and reason like 'Quantity mismatch%';
    if (j->>'matched')::boolean = false and v_status = 'on_hold' and n = 1 then
      res := res || E'PASS B1 QA invoice (200 kg billed, 195 kg received) goes on hold, not approved\n';
    else fails := fails + 1; res := res || format(E'FAIL B1 match=%s status=%s holds=%s\n', j, v_status, n); end if;
  exception when others then fails := fails + 1; res := res || 'FAIL B1 ' || sqlerrm || E'\n'; end;
  begin
    perform public.approve_supplier_invoice(inv_ok);
    fails := fails + 1; res := res || E'FAIL B2 matcher approved an invoice\n';
  exception when insufficient_privilege then res := res || E'PASS B2 matching and approving are separate permissions\n'; end;
  reset role;

  -- ── Clerk edits a line of the on-hold invoice → back to received ──
  perform set_config('request.jwt.claims', '${CLERK}', true); set local role authenticated;
  begin
    update public.supplier_invoice_lines set qty = 195, line_total_cents = 17550000 where id = line;
    reset role;
    select status::text into v_status from public.supplier_invoices where id = inv;
    if v_status = 'received' then res := res || E'PASS C1 editing an on-hold invoice sends it back for re-match\n';
    else fails := fails + 1; res := res || format(E'FAIL C1 status after edit = %s\n', v_status); end if;
  exception when others then reset role; fails := fails + 1; res := res || 'FAIL C1 ' || sqlerrm || E'\n'; end;

  -- ── Approver: invoices.approve ──
  perform set_config('request.jwt.claims', '${APPROVER}', true); set local role authenticated;
  begin
    perform public.approve_supplier_invoice(inv_ok);
    reset role;
    select status::text, approved_by into v_status, v_by from public.supplier_invoices where id = inv_ok;
    select count(*) into n from public.audit_logs where action = 'invoice.approved' and entity_id = inv_ok::text;
    if v_status = 'approved' and v_by = '00000000-0000-0000-0000-00000000a99e' and n = 1 then
      res := res || E'PASS D1 approver approves; who and when are recorded and audited\n';
    else fails := fails + 1; res := res || format(E'FAIL D1 status=%s by=%s audit=%s\n', v_status, v_by, n); end if;
  exception when others then reset role; fails := fails + 1; res := res || 'FAIL D1 ' || sqlerrm || E'\n'; end;

  -- ── Payer: payments only through record_supplier_payment ──
  perform set_config('request.jwt.claims', '${PAYER}', true); set local role authenticated;
  begin
    insert into public.supplier_payments (supplier_id, amount_cents) values (sup, 999);
    fails := fails + 1; res := res || E'FAIL E1 payer inserted a payment row directly\n';
  exception when insufficient_privilege then res := res || E'PASS E1 payment rows cannot be written directly\n'; end;
  begin
    delete from public.supplier_payments where id = pay;
    delete from public.supplier_payment_holds where id = hold;
    reset role;
    select count(*) into n from public.supplier_payments where id = pay;
    select n + count(*) into n from public.supplier_payment_holds where id = hold;
    if n = 2 then res := res || E'PASS E2 payments and holds cannot be deleted directly\n';
    else fails := fails + 1; res := res || E'FAIL E2 a payment or hold was deleted\n'; end if;
  exception when others then reset role; fails := fails + 1; res := res || 'FAIL E2 ' || sqlerrm || E'\n'; end;
  perform set_config('request.jwt.claims', '${PAYER}', true); set local role authenticated;
  begin
    perform public.record_supplier_payment(sup, 20000, 'bank_transfer', 'QA-REF',
      jsonb_build_array(jsonb_build_object('invoice_id', inv_ok, 'amount_cents', 20000)));
    reset role;
    select status::text into v_status from public.supplier_invoices where id = inv_ok;
    if v_status = 'partially_paid' then res := res || E'PASS E3 paying through the workflow still works\n';
    else fails := fails + 1; res := res || format(E'FAIL E3 status after payment = %s\n', v_status); end if;
  exception when others then reset role; fails := fails + 1; res := res || 'FAIL E3 ' || sqlerrm || E'\n'; end;

  -- ── Waiter: plain staff can no longer read supplier finance ──
  perform set_config('request.jwt.claims', '${WAITER}', true); set local role authenticated;
  begin
    select (select count(*) from public.supplier_invoices) + (select count(*) from public.supplier_payments)
         + (select count(*) from public.supplier_payment_holds) + (select count(*) from public.daily_closings) into n;
    reset role;
    if n = 0 then res := res || E'PASS F1 waiter sees no invoices, payments, holds or daily closings\n';
    else fails := fails + 1; res := res || format(E'FAIL F1 waiter can read %s finance rows\n', n); end if;
  exception when others then reset role; fails := fails + 1; res := res || 'FAIL F1 ' || sqlerrm || E'\n'; end;

  -- ── Audit coverage ──
  select count(*) into n from public.audit_logs where entity in ('supplier_invoices', 'supplier_payments', 'supplier_invoice_lines')
     and created_at >= now() - interval '1 minute';
  if n > 0 then res := res || format(E'PASS G1 invoice and payment changes are in the audit log (%s rows)\n', n);
  else fails := fails + 1; res := res || E'FAIL G1 no audit rows for invoices/payments\n'; end if;

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
