import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { createTenantServerClient } from '@/lib/supabase/tenant-server';
import { gatePortalPage } from '@/lib/permissions';
import { DashboardStat } from './DashboardStat';
import { LiveRefresh } from '@/components/LiveRefresh';
import { SalesTrend, type DayRow } from './SalesTrend';
import { DashboardClient } from './DashboardClient';
import { formatCents, formatDateTime } from '@/lib/format';
import { getPlanByTier } from '@/lib/plans';
import { can } from '@/lib/permissions';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Dashboard' };

const STATUS_TONE: Record<string, string> = {
  paid: 'text-ok',
  served: 'text-ok',
  ready: 'text-warn',
  in_kitchen: 'text-warn',
  pending: 'text-muted',
  void: 'text-danger',
};

export default async function DashboardPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const t = await createTenantServerClient(slug);
  if (!t) notFound();
  const supabase = t.client;

  const { user, role: viewerRole, perms: viewerPerms } = await gatePortalPage(supabase, slug, '');
  const canViewPortals = can(viewerPerms, viewerRole, 'portals.view');

  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10);
  const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0).toISOString().slice(0, 10);
  const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

  const [membershipRes, ordersRes, menuRes, inventoryRes, salesByDayRes, brandKitRes, pendingPurchasesRes, portalsRes] = await Promise.all([
    supabase.from('memberships').select('role').eq('user_id', user.id).maybeSingle(),
    supabase
      .from('orders')
      .select('id, order_number, status, channel, table_label, total_cents, created_at')
      .order('created_at', { ascending: false })
      .limit(8),
    supabase.from('menu_items').select('id, is_available'),
    supabase
      .from('inventory_items')
      .select('id, name, unit, stock_qty, min_threshold')
      .order('name'),
    supabase.rpc('sales_by_day', { p_from: monthStart, p_to: monthEnd }),
    supabase.rpc('get_brand_kit'),
    supabase.from('purchase_orders').select('id', { count: 'exact', head: true }).in('status', ['draft', 'sent', 'partial']),
    canViewPortals
      ? supabase
          .from('portals')
          .select('id, name, status, last_login_at, last_logout_at')
          .neq('type', 'super_admin')
          .order('last_login_at', { ascending: false, nullsFirst: false })
      : Promise.resolve({ data: null }),
  ]);
  const brandKitRow = Array.isArray(brandKitRes.data) ? brandKitRes.data[0] : brandKitRes.data;
  const logoUrl: string | null = (brandKitRow as { logo_url?: string | null } | null)?.logo_url ?? null;

  const since = new Date();
  since.setHours(0, 0, 0, 0);
  const todayRes = await supabase
    .from('orders')
    .select('total_cents')
    .gte('created_at', since.toISOString());

  const role = (membershipRes.data as { role?: string } | null)?.role ?? 'member';
  const orders = ordersRes.data ?? [];
  const menu = menuRes.data ?? [];
  const inventory = inventoryRes.data ?? [];
  const todayOrders = todayRes.data ?? [];
  const firstError =
    membershipRes.error || ordersRes.error || menuRes.error || inventoryRes.error;

  const todayCount = todayOrders.length;
  const todayRevenue = todayOrders.reduce(
    (s: number, o: { total_cents: number | null }) => s + (o.total_cents ?? 0),
    0,
  );
  const lowStock = inventory.filter(
    (i: { stock_qty: number; min_threshold: number }) =>
      Number(i.stock_qty) <= Number(i.min_threshold),
  );
  const avgOrderValue = todayCount > 0 ? Math.round(todayRevenue / todayCount) : 0;
  const pendingPurchases = pendingPurchasesRes.count ?? 0;
  const portalActivity = (portalsRes.data ?? []) as {
    id: string;
    name: string;
    status: string;
    last_login_at: string | null;
    last_logout_at: string | null;
  }[];

  const plan = await getPlanByTier(t.config.tier ?? 'starter');
  const features = plan?.features ?? [];

  return (
    <div className="space-y-8 max-w-6xl">
      <LiveRefresh tables={['orders', 'payments']} channel="dashboard-live" />
      <header>
        <h1 className="text-xl font-black text-body">Good morning, {role === 'owner' ? 'Owner' : 'Team'}</h1>
        <p className="text-muted">
          Here&rsquo;s what&rsquo;s happening across {t.config.restaurantName} today ·{' '}
          <span className="font-semibold text-body">{plan?.name ?? t.config.tier}</span>
          {t.config.subscriptionStatus ? (
            <>
              {' '}
              (<span className="capitalize">{t.config.subscriptionStatus}</span>
              {t.config.billingInterval ? `, ${t.config.billingInterval}` : ''})
            </>
          ) : null}
        </p>
      </header>

      {firstError && (
        <div className="rounded-lg border border-danger/40 bg-danger/10 text-danger p-4 text-xs">
          {firstError.message}
        </div>
      )}

      <section className="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-4">
        <DashboardStat label="Today's sales" value={formatCents(todayRevenue)} hint="vs. yesterday" />
        <DashboardStat label="Orders" value={todayCount} />
        <DashboardStat label="Average order value" value={formatCents(avgOrderValue)} />
        <DashboardStat
          label="Menu items"
          value={menu.length}
          hint={`${menu.filter((m: { is_available: boolean }) => m.is_available).length} available`}
        />
        <DashboardStat
          label="Low stock"
          value={lowStock.length}
          tone={lowStock.length > 0 ? 'danger' : 'ok'}
          hint={`of ${inventory.length} items`}
        />
        <DashboardStat
          label="Pending purchases"
          value={pendingPurchases}
          tone={pendingPurchases > 0 ? 'warn' : 'ok'}
          href={`/r/${slug}/purchasing`}
        />
      </section>

      <DashboardClient slug={slug} restaurantName={t.config.restaurantName} logoUrl={logoUrl} />

      <SalesTrend initialMonth={currentMonth} initialDays={(salesByDayRes.data as DayRow[] | null) ?? []} />

      <div className="grid lg:grid-cols-3 gap-6">
        <section className="lg:col-span-2 rounded-lg border border-border bg-surface p-5">
          <h2 className="font-bold mb-4">Recent orders</h2>
          {orders.length === 0 ? (
            <p className="text-muted text-xs">No orders yet.</p>
          ) : (
            <table className="w-full text-left text-xs">
              <thead className="text-muted">
                <tr className="border-b border-border">
                  <th className="pb-2 font-semibold">#</th>
                  <th className="pb-2 font-semibold">Where</th>
                  <th className="pb-2 font-semibold">Status</th>
                  <th className="pb-2 font-semibold text-right">Total</th>
                  <th className="pb-2 font-semibold text-right">Time</th>
                </tr>
              </thead>
              <tbody>
                {orders.map(
                  (o: {
                    id: string;
                    order_number: number;
                    status: string;
                    channel: string;
                    table_label: string | null;
                    total_cents: number;
                    created_at: string;
                  }) => (
                    <tr key={o.id} className="border-b border-border/60 last:border-0">
                      <td className="py-2 font-mono font-bold">{o.order_number}</td>
                      <td className="py-2 text-muted">
                        {o.table_label ?? o.channel.replace('_', ' ')}
                      </td>
                      <td className={`py-2 font-semibold ${STATUS_TONE[o.status] ?? 'text-body'}`}>
                        {o.status.replace('_', ' ')}
                      </td>
                      <td className="py-2 text-right font-bold">{formatCents(o.total_cents)}</td>
                      <td className="py-2 text-right text-muted">
                        {formatDateTime(o.created_at)}
                      </td>
                    </tr>
                  ),
                )}
              </tbody>
            </table>
          )}
        </section>

        <section className="rounded-lg border border-border bg-surface p-5">
          <h2 className="font-bold mb-4">Plan features</h2>
          {features.length === 0 ? (
            <p className="text-muted text-xs">
              {plan?.name ?? 'Your plan'} — POS and QR menu only.
            </p>
          ) : (
            <ul className="space-y-2 text-xs">
              {features.map((f) => (
                <li key={f} className="flex items-center gap-2">
                  <span className="text-ok">✓</span>
                  <span className="text-body">{f}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <section className="rounded-lg border border-border bg-surface p-5">
        <h2 className="font-bold mb-4">Inventory</h2>
        {inventory.length === 0 ? (
          <p className="text-muted text-xs">No inventory items.</p>
        ) : (
          <table className="w-full text-left text-xs">
            <thead className="text-muted">
              <tr className="border-b border-border">
                <th className="pb-2 font-semibold">Item</th>
                <th className="pb-2 font-semibold text-right">On hand</th>
                <th className="pb-2 font-semibold text-right">Min</th>
                <th className="pb-2 font-semibold text-right">State</th>
              </tr>
            </thead>
            <tbody>
              {inventory.map(
                (i: {
                  id: string;
                  name: string;
                  unit: string;
                  stock_qty: number;
                  min_threshold: number;
                }) => {
                  const low = Number(i.stock_qty) <= Number(i.min_threshold);
                  return (
                    <tr key={i.id} className="border-b border-border/60 last:border-0">
                      <td className="py-2 font-semibold">{i.name}</td>
                      <td className="py-2 text-right">
                        {i.stock_qty} {i.unit}
                      </td>
                      <td className="py-2 text-right text-muted">{i.min_threshold}</td>
                      <td
                        className={`py-2 text-right font-semibold ${low ? 'text-danger' : 'text-ok'}`}
                      >
                        {low ? 'low' : 'ok'}
                      </td>
                    </tr>
                  );
                },
              )}
            </tbody>
          </table>
        )}
      </section>

      {canViewPortals && (
        <section className="rounded-lg border border-border bg-surface p-5">
          <div className="flex items-center justify-between mb-4">
            <h2 className="font-bold">Portal activity</h2>
            <a href={`/r/${slug}/portals`} className="text-primary text-xs font-semibold hover:underline">
              Manage portals →
            </a>
          </div>
          {portalActivity.length === 0 ? (
            <p className="text-muted text-xs">No portals created yet.</p>
          ) : (
            <table className="w-full text-left text-xs">
              <thead className="text-muted">
                <tr className="border-b border-border">
                  <th className="pb-2 font-semibold">Portal</th>
                  <th className="pb-2 font-semibold">Status</th>
                  <th className="pb-2 font-semibold">Last sign-in</th>
                  <th className="pb-2 font-semibold">Last sign-out</th>
                </tr>
              </thead>
              <tbody>
                {portalActivity.map((p) => (
                  <tr key={p.id} className="border-b border-border/60 last:border-0">
                    <td className="py-2 font-semibold">{p.name}</td>
                    <td className={`py-2 ${p.status === 'active' ? 'text-ok' : 'text-muted'}`}>{p.status}</td>
                    <td className="py-2 text-muted">{p.last_login_at ? formatDateTime(p.last_login_at) : 'Never signed in'}</td>
                    <td className="py-2 text-muted">{p.last_logout_at ? formatDateTime(p.last_logout_at) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      )}
    </div>
  );
}
