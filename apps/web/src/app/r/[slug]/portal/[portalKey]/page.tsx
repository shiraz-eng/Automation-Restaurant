import { notFound, redirect } from 'next/navigation';
import { createTenantServerClient } from '@/lib/supabase/tenant-server';
import { Card } from '@/components/ui';
import {
  KitchenPortalBoard,
  type KOrder,
  type KVariant,
} from './KitchenPortalBoard';
import { AttendancePortalBoard, type RosterRow } from './AttendancePortalBoard';

export const dynamic = 'force-dynamic';

const BLURB: Record<string, string> = {
  super_admin: 'Full control — use the admin portal at /r/<slug>.',
  checkout: 'Accept payment → print invoice → update order. Modules arrive in Phase 3.',
  manager: 'Operational oversight scoped to its permissions.',
  custom: 'A custom portal limited to the permissions below.',
};

const ACTIVE = ['pending', 'in_kitchen', 'ready'];

export default async function PortalHome({
  params,
}: {
  params: Promise<{ slug: string; portalKey: string }>;
}) {
  const { slug, portalKey } = await params;
  const t = await createTenantServerClient(slug);
  if (!t) notFound();

  const { data: portal } = await t.client
    .from('portals')
    .select('name, type, route_key, status, permissions')
    .eq('route_key', portalKey)
    .maybeSingle();
  if (!portal) notFound();
  if (portal.type === 'super_admin') redirect(`/r/${slug}`);

  const perms: string[] = portal.permissions ?? [];
  const has = (k: string) => perms.includes('*') || perms.includes(k);

  if (portal.type === 'kitchen') {
    const [{ data: orders }, { data: variants }] = await Promise.all([
      t.client
        .from('orders')
        .select(
          'id, order_number, table_label, channel, status, customer_note, created_at, order_lines(id, name_snapshot, qty, kds_status, customer_note)',
        )
        .in('status', ACTIVE)
        .order('created_at', { ascending: true }),
      t.client
        .from('menu_variants')
        .select('id, name, is_available, track_availability, available_qty, menu_items(name)')
        .order('name'),
    ]);
    return (
      <div className="space-y-4">
        <h1 className="text-xl font-black">{portal.name}</h1>
        <KitchenPortalBoard
          initialOrders={(orders ?? []) as KOrder[]}
          initialVariants={(variants ?? []) as unknown as KVariant[]}
          canAvailability={has('kitchen.manage_availability') || has('availability.update')}
          canWaste={has('kitchen.record_waste')}
        />
      </div>
    );
  }

  if (portal.type === 'attendance') {
    const { data: roster } = await t.client.rpc('attendance_roster', {});
    return (
      <div className="space-y-4">
        <h1 className="text-xl font-black">{portal.name}</h1>
        <AttendancePortalBoard
          initialRoster={(roster ?? []) as RosterRow[]}
          canMark={has('attendance.mark')}
          canCheckIn={has('attendance.check_in')}
        />
      </div>
    );
  }

  return (
    <div className="max-w-2xl space-y-6">
      <div>
        <h1 className="text-xl font-black">{portal.name}</h1>
        <p className="text-muted text-xs mt-1 capitalize">{portal.type.replace('_', ' ')} portal</p>
      </div>

      <Card>
        <p className="text-sm">{BLURB[portal.type] ?? BLURB.custom}</p>
      </Card>

      <Card>
        <h2 className="font-bold text-sm mb-3">This portal can</h2>
        {perms.length === 0 ? (
          <p className="text-muted text-xs">No permissions granted yet — configure in Portal Management.</p>
        ) : perms.includes('*') ? (
          <p className="text-xs">Everything.</p>
        ) : (
          <ul className="grid grid-cols-2 gap-x-6 gap-y-1 text-xs font-mono">
            {perms.map((p) => (
              <li key={p} className="text-ok">
                ✓ {p}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
