import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { createTenantServerClient } from '@/lib/supabase/tenant-server';
import { gatePortalPage } from '@/lib/permissions';
import { KotHistory, type HistoryRow, type AuditRow } from './KotHistory';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'KOT History' };

const SELECT =
  'id, order_number, table_label, channel, created_at, status, ' +
  'order_lines(id, name_snapshot, qty, kds_status, menu_item_id, menu_items(station))';

export default async function KotHistoryPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const t = await createTenantServerClient(slug);
  if (!t) notFound();

  await gatePortalPage(t.client, slug, 'kitchen.view');

  const since = new Date();
  since.setDate(since.getDate() - 30);

  const { data: orders, error } = await t.client
    .from('orders')
    .select(SELECT)
    .in('status', ['served', 'paid', 'void'])
    .gte('created_at', since.toISOString())
    .order('created_at', { ascending: false })
    .limit(300);

  const orderIds = ((orders ?? []) as unknown as HistoryRow[]).map((o) => o.id);
  const { data: auditRows } = orderIds.length
    ? await t.client
        .from('audit_logs')
        .select('entity_id, action, created_at')
        .eq('entity', 'orders')
        .in('entity_id', orderIds)
        .in('action', ['kitchen.start', 'kitchen.ready', 'kitchen.complete'])
    : { data: [] };

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-black">KOT History</h1>
        <p className="text-muted text-xs mt-1">Completed and cancelled tickets from the last 30 days.</p>
      </div>
      {error ? (
        <div className="rounded-lg border border-danger/40 bg-danger/10 text-danger p-4 text-xs">{error.message}</div>
      ) : (
        <KotHistory rows={(orders ?? []) as unknown as HistoryRow[]} auditRows={(auditRows ?? []) as unknown as AuditRow[]} />
      )}
    </div>
  );
}
