import { notFound } from 'next/navigation';
import { createTenantServerClient } from '@/lib/supabase/tenant-server';
import { gatePortalPage } from '@/lib/permissions';
import { PurchasingClient, type PurchaseOrder } from './PurchasingClient';

export const dynamic = 'force-dynamic';

export default async function PurchasingPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const t = await createTenantServerClient(slug);
  if (!t) notFound();

  await gatePortalPage(t.client, slug, 'purchases.view');

  const [{ data: suppliers }, { data: items }, { data: orders, error }] = await Promise.all([
    t.client.from('suppliers').select('id, name').order('name'),
    t.client.from('inventory_items').select('id, name, unit').order('name'),
    t.client
      .from('purchase_orders')
      .select(
        'id, po_number, status, expected_at, notes, created_at, received_at, suppliers(name), purchase_order_lines(id, description, qty, unit_cost_cents, received_qty, inventory_item_id)',
      )
      .order('created_at', { ascending: false }),
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
    <div className="space-y-6 max-w-4xl">
      <div>
        <h1 className="text-xl font-black">Purchasing</h1>
        <p className="text-muted text-xs mt-1">
          Raise purchase orders against your suppliers. Marking one received adds every
          outstanding line quantity to inventory and writes a stock movement.
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
        />
      )}
    </div>
  );
}
