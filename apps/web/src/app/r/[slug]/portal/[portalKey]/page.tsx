import { notFound, redirect } from 'next/navigation';
import { createTenantServerClient } from '@/lib/supabase/tenant-server';
import { Card } from '@/components/ui';
import { StatCard } from '@/components/StatCard';
import { formatCents } from '@/lib/format';
import { PORTAL_BUNDLES } from '@/lib/portalBundles';
import {
  KitchenPortalBoard,
  type KOrder,
  type KVariant,
  type Counter,
} from './KitchenPortalBoard';
import { AttendancePortalBoard, type RosterRow } from './AttendancePortalBoard';
import { CheckoutClient, type Bill } from '../../(portal)/checkout/CheckoutClient';

export const dynamic = 'force-dynamic';

const BLURB: Record<string, string> = {
  manager: 'Operational oversight scoped to its granted portals.',
  custom: 'A custom portal, limited to the portals granted below.',
};

const ACTIVE = ['pending', 'in_kitchen', 'ready'];
const UNPAID = ['pending', 'in_kitchen', 'ready', 'served'];

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
    const [{ data: orders }, { data: variants }, { data: counters }] = await Promise.all([
      t.client
        .from('orders')
        .select(
          'id, order_number, table_label, channel, status, customer_note, created_at, pickup_counter_portal_id, order_lines(id, name_snapshot, qty, kds_status, modifiers, customer_note)',
        )
        .in('status', ACTIVE)
        .order('created_at', { ascending: true }),
      t.client
        .from('menu_variants')
        .select('id, name, is_available, track_availability, available_qty, menu_items(name)')
        .order('name'),
      t.client.from('portals').select('id, name').eq('type', 'checkout').eq('status', 'active').order('name'),
    ]);
    return (
      <div className="space-y-4">
        <h1 className="text-xl font-black">{portal.name}</h1>
        <KitchenPortalBoard
          initialOrders={(orders ?? []) as KOrder[]}
          initialVariants={(variants ?? []) as unknown as KVariant[]}
          counters={(counters ?? []) as Counter[]}
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

  if (portal.type === 'checkout') {
    const { data: bills } = await t.client
      .from('orders')
      .select(
        'id, order_number, session_id, table_label, customer_name, status, subtotal_cents, discount_cents, tax_cents, total_cents, refunded_cents, created_at, order_lines(id, name_snapshot, qty, unit_price_cents, line_total_cents), payments(id, amount_cents, method, status, refunded_cents, created_at)',
      )
      .in('status', UNPAID)
      .order('created_at', { ascending: true });
    return (
      <div className="space-y-4">
        <h1 className="text-xl font-black">{portal.name}</h1>
        <CheckoutClient
          restaurantName={t.config.restaurantName}
          initial={(bills ?? []) as Bill[]}
          canRefund={has('payments.refund')}
          canVoid={has('payments.void')}
          canDiscount={has('orders.apply_discount')}
          canCancel={has('orders.cancel')}
        />
      </div>
    );
  }

  // General board (manager/custom types) — a real, live operational
  // summary instead of a bare permission list, built from the SAME
  // queries/RPCs the Dashboard and other portals already use, each
  // fetched only when this portal's own granted permissions cover it.
  // t.client is the portal account's own RLS-scoped client (not
  // service-role), so period_profitability's own has_perm() check is a
  // second, real backstop here — not just this page's has() gate.
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const monthStart = new Date(todayStart.getFullYear(), todayStart.getMonth(), 1);

  const [ordersRes, kitchenRes, stockRes, profitRes] = await Promise.all([
    has('orders.view')
      ? t.client.from('orders').select('total_cents, status, paid_at').gte('created_at', todayStart.toISOString())
      : Promise.resolve({ data: null }),
    has('kitchen.view')
      ? t.client.from('orders').select('id', { count: 'exact', head: true }).in('status', ACTIVE)
      : Promise.resolve({ data: null, count: null }),
    has('stock.view')
      ? t.client.from('inventory_items').select('name, stock_qty, min_threshold, unit').order('name')
      : Promise.resolve({ data: null }),
    has('finance.view')
      ? t.client.rpc('period_profitability', { p_from: monthStart.toISOString(), p_to: new Date().toISOString() })
      : Promise.resolve({ data: null, error: null }),
  ]);

  const todayOrders = (ordersRes.data ?? []) as { total_cents: number; status: string; paid_at: string | null }[];
  const revenueToday = todayOrders.filter((o) => o.paid_at).reduce((s, o) => s + o.total_cents, 0);
  const lowStock = ((stockRes.data ?? []) as { name: string; stock_qty: number; min_threshold: number; unit: string }[]).filter(
    (i) => Number(i.stock_qty) <= Number(i.min_threshold),
  );
  const profit = (profitRes.data as { net_profit_cents: number; net_sales_cents: number }[] | null)?.[0];

  const grantedBundles = PORTAL_BUNDLES.filter(({ keys }) => keys.some((k) => has(k)));

  return (
    <div className="max-w-3xl space-y-6">
      <div>
        <h1 className="text-xl font-black">{portal.name}</h1>
        <p className="text-muted text-xs mt-1">{BLURB[portal.type] ?? BLURB.custom}</p>
      </div>

      {perms.length === 0 ? (
        <Card>
          <p className="text-muted text-xs">No portals granted yet — configure this in Portal Management.</p>
        </Card>
      ) : (
        <>
          {(has('orders.view') || has('kitchen.view') || has('stock.view') || has('finance.view')) && (
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              {has('orders.view') && (
                <StatCard label="Orders today" value={todayOrders.length} hint={`${formatCents(revenueToday)} paid`} />
              )}
              {has('kitchen.view') && <StatCard label="Active kitchen tickets" value={kitchenRes.count ?? 0} />}
              {has('stock.view') && (
                <StatCard label="Low stock" value={lowStock.length} tone={lowStock.length > 0 ? 'warn' : 'default'} />
              )}
              {has('finance.view') && profit && (
                <StatCard
                  label="Net profit (this month)"
                  value={formatCents(profit.net_profit_cents)}
                  tone={profit.net_profit_cents >= 0 ? 'ok' : 'danger'}
                />
              )}
            </div>
          )}

          {has('stock.view') && lowStock.length > 0 && (
            <Card>
              <h2 className="font-bold text-sm mb-3">Low stock</h2>
              <ul className="text-xs space-y-1">
                {lowStock.slice(0, 8).map((i) => (
                  <li key={i.name} className="flex justify-between">
                    <span>{i.name}</span>
                    <span className="text-warn font-mono">
                      {i.stock_qty}{i.unit} / min {i.min_threshold}{i.unit}
                    </span>
                  </li>
                ))}
              </ul>
            </Card>
          )}

          <Card>
            <h2 className="font-bold text-sm mb-3">Portals granted</h2>
            {perms.includes('*') ? (
              <p className="text-xs">Everything.</p>
            ) : grantedBundles.length === 0 ? (
              <p className="text-muted text-xs">No recognised portal domain — check Portal Management.</p>
            ) : (
              <ul className="grid grid-cols-2 gap-x-6 gap-y-1 text-xs">
                {grantedBundles.map(({ portal: name, keys }) => {
                  const grantedCount = keys.filter((k) => has(k)).length;
                  return (
                    <li key={name} className="text-ok">
                      ✓ {name}
                      {grantedCount < keys.length && (
                        <span className="text-muted"> ({grantedCount}/{keys.length})</span>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>
        </>
      )}
    </div>
  );
}
