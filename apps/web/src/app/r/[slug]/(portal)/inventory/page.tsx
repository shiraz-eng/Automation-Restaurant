import { notFound } from 'next/navigation';
import { createTenantServerClient } from '@/lib/supabase/tenant-server';
import { gatePortalPage, can } from '@/lib/permissions';
import { InventoryManager } from './InventoryManager';
import { Card } from '@/components/ui';
import { formatDateTime } from '@/lib/format';
import { SectionReportButtons } from '@/components/SectionReportButtons';

export const dynamic = 'force-dynamic';

export default async function InventoryPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const t = await createTenantServerClient(slug);
  if (!t) notFound();

  const { role, perms } = await gatePortalPage(t.client, slug, 'stock.view');
  const canManageAutomation = can(perms, role, 'finance.manage_purchases');

  const [{ data: items, error }, { data: ledgerRaw }, { data: suppliersRaw }, { data: supplierItemsRaw }, { data: settingsRow }] =
    await Promise.all([
      t.client
        .from('inventory_items')
        .select(
          'id, name, unit, stock_qty, min_threshold, target_stock_qty, auto_reorder_email, supplier_name, cost_cents_per_base_unit',
        )
        .order('name'),
      t.client
        .from('stock_ledger')
        .select('id, delta_qty, reason, created_at, inventory_items(name)')
        .order('created_at', { ascending: false })
        .limit(15),
      canManageAutomation
        ? t.client.from('suppliers').select('id, name, email').eq('is_active', true).order('name')
        : Promise.resolve({ data: [] }),
      canManageAutomation
        ? t.client.from('supplier_items').select('id, supplier_id, inventory_item_id, is_preferred').eq('is_preferred', true)
        : Promise.resolve({ data: [] }),
      canManageAutomation ? t.client.from('purchasing_settings').select('low_stock_email_enabled').maybeSingle() : Promise.resolve({ data: null }),
    ]);

  const suppliers = (suppliersRaw ?? []) as { id: string; name: string; email: string | null }[];
  const preferredBySupplierItem = new Map(
    ((supplierItemsRaw ?? []) as { id: string; supplier_id: string; inventory_item_id: string }[]).map((si) => [
      si.inventory_item_id,
      { supplierItemId: si.id, supplierId: si.supplier_id },
    ]),
  );

  const ledger = ((ledgerRaw ?? []) as unknown as {
    id: string;
    delta_qty: number;
    reason: string;
    created_at: string;
    inventory_items: { name: string } | { name: string }[] | null;
  }[]).map((l) => ({
    id: l.id,
    delta_qty: l.delta_qty,
    reason: l.reason,
    created_at: l.created_at,
    item_name: Array.isArray(l.inventory_items)
      ? (l.inventory_items[0]?.name ?? '—')
      : (l.inventory_items?.name ?? '—'),
  }));

  return (
    <div className="space-y-6 max-w-4xl">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <h1 className="text-xl font-black">Inventory</h1>
        <SectionReportButtons slug={slug} restaurantName={t.config.restaurantName} domain="inventory" label="Inventory" />
      </div>
      {error ? (
        <div className="rounded-lg border border-danger/40 bg-danger/10 text-danger p-4 text-xs">
          {error.message}
        </div>
      ) : (
        <InventoryManager
          items={items ?? []}
          canViewCost={can(perms, role, 'inventory.view_cost')}
          canManageAutomation={canManageAutomation}
          suppliers={suppliers}
          preferredBySupplierItem={Object.fromEntries(preferredBySupplierItem)}
          lowStockEmailEnabled={(settingsRow as { low_stock_email_enabled?: boolean } | null)?.low_stock_email_enabled ?? false}
        />
      )}

      <Card>
        <h2 className="font-bold mb-3 text-sm">Recent stock movements</h2>
        {ledger.length === 0 ? (
          <p className="text-muted text-xs">Nothing yet.</p>
        ) : (
          <table className="w-full text-left text-xs">
            <tbody>
              {ledger.map((l) => (
                <tr key={l.id} className="border-b border-border/60 last:border-0">
                  <td className="py-2">{l.item_name}</td>
                  <td className="py-2 text-muted">{l.reason.replace('_', ' ')}</td>
                  <td
                    className={`py-2 text-right font-mono ${Number(l.delta_qty) < 0 ? 'text-danger' : 'text-ok'}`}
                  >
                    {Number(l.delta_qty) > 0 ? '+' : ''}
                    {l.delta_qty}
                  </td>
                  <td className="py-2 text-right text-muted">{formatDateTime(l.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}
