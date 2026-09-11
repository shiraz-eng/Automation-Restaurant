import { notFound } from 'next/navigation';
import { createTenantServerClient } from '@/lib/supabase/tenant-server';
import { gatePortalPage, can } from '@/lib/permissions';
import { PurchasingClient, type PurchaseOrder, type Invoice, type Hold, type PayableRow } from './PurchasingClient';

export const dynamic = 'force-dynamic';

export default async function PurchasingPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const t = await createTenantServerClient(slug);
  if (!t) notFound();

  const { role, perms } = await gatePortalPage(t.client, slug, 'purchases.view');
  const canInvoice = can(perms, role, 'invoices.create');
  const canMatch = can(perms, role, 'invoices.match');
  const canPay = can(perms, role, 'payables.record_payment');
  const canManagePayables = can(perms, role, 'payables.manage');
  const canViewPayables = can(perms, role, 'payables.view') || can(perms, role, 'finance.view');

  const [{ data: suppliers }, { data: items }, { data: orders, error }, invRes, holdRes, payableRes] = await Promise.all([
    t.client.from('suppliers').select('id, name').eq('is_active', true).order('name'),
    t.client.from('inventory_items').select('id, name, unit').order('name'),
    t.client
      .from('purchase_orders')
      .select(
        'id, po_number, status, expected_at, notes, created_at, received_at, approved_at, sent_at, supplier_id, subtotal_cents, suppliers(name), purchase_order_lines(id, description, qty, unit_cost_cents, received_qty, rejected_qty, reject_reason, inventory_item_id)',
      )
      .order('created_at', { ascending: false }),
    canInvoice || canMatch
      ? t.client
          .from('supplier_invoices')
          .select(
            'id, invoice_ref, supplier_invoice_number, invoice_date, due_date, total_cents, status, purchase_order_id, supplier_id, suppliers(name)',
          )
          .order('invoice_date', { ascending: false })
          .limit(30)
      : Promise.resolve({ data: [] as Invoice[] }),
    canManagePayables || canViewPayables
      ? t.client
          .from('supplier_payment_holds')
          .select('id, reason, amount_cents, status, created_at, invoice_id, supplier_invoices(supplier_invoice_number, suppliers(name))')
          .eq('status', 'open')
          .order('created_at', { ascending: false })
      : Promise.resolve({ data: [] as Hold[] }),
    canViewPayables ? t.client.rpc('supplier_payable') : Promise.resolve({ data: [] as PayableRow[] }),
  ]);

  const normalised = ((orders ?? []) as unknown as (Omit<PurchaseOrder, 'supplier_name'> & {
    suppliers: { name: string } | { name: string }[] | null;
  })[]).map((o) => ({
    ...o,
    supplier_name: Array.isArray(o.suppliers)
      ? (o.suppliers[0]?.name ?? null)
      : (o.suppliers?.name ?? null),
  })) as PurchaseOrder[];

  return (
    <div className="space-y-8 max-w-5xl">
      <div>
        <h1 className="text-xl font-black">Purchasing</h1>
        <p className="text-muted text-xs mt-1">
          Suppliers → purchase orders → receiving → invoices → matching → payables.
        </p>
      </div>
      {error ? (
        <div className="rounded-lg border border-danger/40 bg-danger/10 text-danger p-4 text-xs">
          {error.message}
        </div>
      ) : (
        <PurchasingClient
          suppliers={suppliers ?? []}
          items={items ?? []}
          orders={normalised}
          invoices={(invRes.data ?? []) as unknown as Invoice[]}
          holds={(holdRes.data ?? []) as unknown as Hold[]}
          payable={(payableRes.data ?? []) as unknown as PayableRow[]}
          canInvoice={canInvoice}
          canMatch={canMatch}
          canPay={canPay}
          canManagePayables={canManagePayables}
          canViewPayables={canViewPayables}
        />
      )}
    </div>
  );
}
