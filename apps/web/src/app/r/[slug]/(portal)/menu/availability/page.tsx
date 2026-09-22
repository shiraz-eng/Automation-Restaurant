import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { createTenantServerClient } from '@/lib/supabase/tenant-server';
import { gatePortalPage } from '@/lib/permissions';
import { AvailabilityHistory, type AvailabilityHistoryRow } from './AvailabilityHistory';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Availability History' };

export default async function AvailabilityHistoryPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const t = await createTenantServerClient(slug);
  if (!t) notFound();

  await gatePortalPage(t.client, slug, 'availability.view');

  const { data, error } = await t.client
    .from('availability_audit_log')
    .select(
      'id, menu_item_id, variant_id, previous_status, new_status, previous_producible_qty, new_producible_qty, ' +
        'bottleneck_inventory_item_id, reason, trigger_type, trigger_reference, actor, created_at, ' +
        'menu_items(name), menu_variants(name), inventory_items(name)',
    )
    .order('created_at', { ascending: false })
    .limit(500);

  return (
    <div className="space-y-6 max-w-6xl">
      <div>
        <h1 className="text-xl font-black">Availability History</h1>
        <p className="text-muted text-xs mt-1">
          Every change the recipe-driven availability engine has made to a product&rsquo;s computed status —
          automatic (inventory consumption, restock, a recipe edit) or a manual recalculation. This is the
          engine&rsquo;s own immutable audit trail, not recomputed here.
        </p>
      </div>
      {error ? (
        <div className="rounded-lg border border-danger/40 bg-danger/10 text-danger p-4 text-xs">{error.message}</div>
      ) : (
        <AvailabilityHistory rows={(data ?? []) as unknown as AvailabilityHistoryRow[]} />
      )}
    </div>
  );
}
