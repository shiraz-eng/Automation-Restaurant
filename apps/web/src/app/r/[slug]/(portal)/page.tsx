import { notFound } from 'next/navigation';
import { createTenantServerClient } from '@/lib/supabase/tenant-server';
import { gatePortalPage } from '@/lib/permissions';
import { StatCard } from '@/components/StatCard';
import { formatCents, formatDateTime } from '@/lib/format';
import { PLAN_FEATURES, isPlanTier } from '@automation-restaurant/shared';

export const dynamic = 'force-dynamic';

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

  const { user } = await gatePortalPage(supabase, slug, '');

  const [membershipRes, ordersRes, menuRes, inventoryRes] = await Promise.all([
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
  ]);

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

  const tier = isPlanTier(t.config.tier) ? t.config.tier : 'starter';
  const features = PLAN_FEATURES[tier];

  return (
    <div className="space-y-8 max-w-6xl">
      <header>
        <h1 className="text-xl font-black">{t.config.restaurantName}</h1>
        <p className="text-muted">
          {role} · plan <span className="font-semibold capitalize text-body">{tier}</span>
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

      <section className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard label="Orders today" value={todayCount} />
        <StatCard label="Revenue today" value={formatCents(todayRevenue)} />
        <StatCard
          label="Menu items"
          value={menu.length}
          hint={`${menu.filter((m: { is_available: boolean }) => m.is_available).length} available`}
        />
        <StatCard
          label="Low stock"
          value={lowStock.length}
          tone={lowStock.length > 0 ? 'danger' : 'ok'}
          hint={`of ${inventory.length} items`}
        />
      </section>

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
              Starter plan — POS and QR menu only.
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
    </div>
  );
}
