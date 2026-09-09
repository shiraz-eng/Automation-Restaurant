import { notFound, redirect } from 'next/navigation';
import { createTenantServerClient } from '@/lib/supabase/tenant-server';
import { InventoryManager } from './InventoryManager';
import { Card } from '@/components/ui';
import { formatDateTime } from '@/lib/format';

export const dynamic = 'force-dynamic';

export default async function InventoryPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const t = await createTenantServerClient(slug);
  if (!t) notFound();

  const {
    data: { user },
  } = await t.client.auth.getUser();
  if (!user) redirect(`/r/${slug}/login`);

  const [{ data: items, error }, { data: ledgerRaw }] = await Promise.all([
    t.client
      .from('inventory_items')
      .select('id, name, unit, stock_qty, min_threshold, supplier_name')
      .order('name'),
    t.client
      .from('stock_ledger')
      .select('id, delta_qty, reason, created_at, inventory_items(name)')
      .order('created_at', { ascending: false })
      .limit(15),
  ]);

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
      <h1 className="text-xl font-black">Inventory</h1>
      {error ? (
        <div className="rounded-lg border border-danger/40 bg-danger/10 text-danger p-4 text-xs">
          {error.message}
        </div>
      ) : (
        <InventoryManager items={items ?? []} />
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
