import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { createTenantServerClient } from '@/lib/supabase/tenant-server';
import { gatePortalPage, can } from '@/lib/permissions';
import { KitchenAvailabilityBoard } from './KitchenAvailabilityBoard';
import { KdsBoard } from './KdsBoard';
import type { Kot, RecipeComponentRow } from './kitchenTypes';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Kitchen Operations' };

const ACTIVE = ['pending', 'in_kitchen', 'ready'];
const SELECT =
  'id, order_number, table_label, customer_name, channel, created_at, status, customer_note, ' +
  'order_lines(id, name_snapshot, variant_name_snapshot, qty, kds_status, modifiers, customer_note, menu_item_id, menu_items(station))';

export default async function KdsPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const t = await createTenantServerClient(slug);
  if (!t) notFound();

  const { role, perms } = await gatePortalPage(t.client, slug, 'kitchen.view');
  const canEdit = can(perms, role, 'kitchen.update_status');

  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);

  const [{ data, error }, { count: completedToday }, { data: recipeComponents }, { data: entitlements }] = await Promise.all([
    t.client.from('orders').select(SELECT).in('status', ACTIVE).order('created_at', { ascending: true }),
    t.client
      .from('orders')
      .select('id', { count: 'exact', head: true })
      .in('status', ['served', 'paid'])
      .gte('created_at', startOfToday.toISOString()),
    t.client
      .from('recipe_components')
      .select('inventory_item_id, qty_per_unit, variant_id, menu_item_id, inventory_items(name, unit)')
      .is('variant_id', null),
    t.client.from('business_settings').select('plan_tier, plan_features').eq('id', true).maybeSingle(),
  ]);
  // Fails open when never synced (plan_tier null), same convention as the
  // portal nav filter — see layout.tsx's own comment for why.
  const stationRoutingEntitled = !entitlements?.plan_tier || (entitlements.plan_features as string[]).includes('kds.station_routing');

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-black">Kitchen Operations</h1>
        <p className="text-muted text-xs mt-1">Manage incoming orders, preparation and kitchen workflow.</p>
      </div>
      {error ? (
        <div className="rounded-lg border border-danger/40 bg-danger/10 text-danger p-4 text-xs">{error.message}</div>
      ) : (
        <KdsBoard
          slug={slug}
          restaurantName={t.config.restaurantName}
          initial={(data ?? []) as unknown as Kot[]}
          completedToday={completedToday ?? 0}
          recipeComponents={(recipeComponents ?? []) as unknown as RecipeComponentRow[]}
          canEdit={canEdit}
          stationRoutingEntitled={stationRoutingEntitled}
        />
      )}
      <KitchenAvailabilityBoard
        canManage={can(perms, role, 'kitchen.manage_availability')}
        canWaste={can(perms, role, 'kitchen.record_waste')}
      />
    </div>
  );
}
