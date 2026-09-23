import { createControlPlaneServerClient } from '@/lib/supabase/control-plane-server';
import { gateAdminPage } from '@/lib/adminPermissions';
import { AdminStatCard, AdminCard } from './_components/ui';
import { TrendChart } from './_components/TrendChart';
import { DateRangeFilter } from './_components/DateRangeFilter';
import {
  computeSaasMetrics,
  type SubRow,
  type PlanLite,
  type TenantLite,
} from '@automation-restaurant/shared';

export const dynamic = 'force-dynamic';

type TenantRow = TenantLite & { restaurant_name: string; slug: string };
type WebhookEvent = {
  id: string;
  type: string;
  summary: string | null;
  tenant_id: string | null;
  received_at: string;
  tenants: { restaurant_name: string } | { restaurant_name: string }[] | null;
};

function one<T>(x: T | T[] | null): T | null {
  return Array.isArray(x) ? (x[0] ?? null) : x;
}

function dayBuckets(rows: { at: string }[], days: number): { label: string; value: number }[] {
  const buckets = new Map<string, number>();
  const now = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    buckets.set(d.toISOString().slice(0, 10), 0);
  }
  for (const r of rows) {
    const key = r.at.slice(0, 10);
    if (buckets.has(key)) buckets.set(key, (buckets.get(key) ?? 0) + 1);
  }
  return [...buckets.entries()].map(([label, value]) => ({ label: label.slice(5), value }));
}

export default async function AdminOverviewPage({
  searchParams,
}: {
  searchParams: Promise<{ days?: string }>;
}) {
  const { days: daysParam } = await searchParams;
  const days = Math.max(1, Math.min(90, Number(daysParam) || 30));
  const cutoff = new Date(Date.now() - days * 86400_000).toISOString();

  const supabase = await createControlPlaneServerClient();
  await gateAdminPage(supabase, 'dashboard.view');

  const [{ data: subs }, { data: plans }, { data: tenants }] = await Promise.all([
    supabase.from('subscriptions').select('tier, billing_interval, status, updated_at, current_period_end'),
    supabase.from('plans').select('tier, name, price_monthly_cents, price_annual_cents'),
    supabase.from('tenants').select('id, restaurant_name, slug, owner_email, status, created_at'),
  ]);

  const subRows = (subs ?? []) as SubRow[];
  const planRows = (plans ?? []) as PlanLite[];
  const tenantRows = (tenants ?? []) as TenantRow[];
  const m = computeSaasMetrics({ subs: subRows, plans: planRows, tenants: tenantRows });

  const { data: alerts } = await supabase
    .from('webhook_events')
    .select('id, type, summary, tenant_id, received_at, tenants(restaurant_name)')
    .in('type', ['invoice.payment_failed', 'customer.subscription.deleted'])
    .gte('received_at', cutoff)
    .order('received_at', { ascending: false })
    .limit(20);
  const alertRows = (alerts ?? []) as unknown as WebhookEvent[];

  const signupTrend = dayBuckets(tenantRows.filter((t) => t.created_at >= cutoff).map((t) => ({ at: t.created_at })), days);
  const cancelTrend = dayBuckets(
    subRows.filter((s) => s.status === 'canceled' && s.updated_at >= cutoff).map((s) => ({ at: s.updated_at })),
    days,
  );
  const recentSignups = [...tenantRows].sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, 8);
  const trialing = subRows.filter((s) => s.status === 'trialing');

  return (
    <div className="space-y-8 max-w-6xl">
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <div className="text-[10px] font-bold uppercase tracking-[0.14em] text-ink-muted">SaaS Overview</div>
          <h1 className="text-xl font-black mt-0.5">Platform-level subscription, billing alerts, and signups</h1>
        </div>
        <DateRangeFilter defaultDays={30} />
      </div>

      <section className="grid grid-cols-2 lg:grid-cols-3 gap-4">
        <AdminStatCard label="MRR" value={`$${(m.mrrCents / 100).toLocaleString()}`} />
        <AdminStatCard label="Active restaurants" value={tenantRows.filter((t) => t.status === 'active').length} tone="ok" />
        <AdminStatCard label="Active subscriptions" value={m.activeCount} tone="ok" />
      </section>

      <section className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <AdminCard>
          <h2 className="font-bold text-sm mb-3">New restaurants ({days}d)</h2>
          <TrendChart points={signupTrend} />
        </AdminCard>
        <AdminCard>
          <h2 className="font-bold text-sm mb-3">Cancellations ({days}d)</h2>
          <TrendChart points={cancelTrend} color="rgb(248 113 113)" />
        </AdminCard>
      </section>

      <section className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <AdminCard>
          <h2 className="font-bold text-sm mb-3">Recent signups</h2>
          {recentSignups.length === 0 ? (
            <p className="text-ink-muted text-xs">No signups yet.</p>
          ) : (
            <div className="space-y-2">
              {recentSignups.map((t) => (
                <div key={t.id} className="flex items-center justify-between text-xs">
                  <span className="font-semibold">{t.restaurant_name}</span>
                  <span className="text-ink-muted">{new Date(t.created_at).toLocaleDateString()}</span>
                </div>
              ))}
            </div>
          )}
        </AdminCard>

        <AdminCard>
          <h2 className="font-bold text-sm mb-3">Trial accounts</h2>
          {trialing.length === 0 ? (
            <p className="text-ink-muted text-xs">No trials active.</p>
          ) : (
            <div className="space-y-2">
              {trialing.map((s, i) => (
                <div key={i} className="flex items-center justify-between text-xs">
                  <span className="font-semibold capitalize">{s.tier}</span>
                  <span className="text-ink-muted">
                    {s.current_period_end ? `ends ${new Date(s.current_period_end).toLocaleDateString()}` : '—'}
                  </span>
                </div>
              ))}
            </div>
          )}
        </AdminCard>
      </section>

      <AdminCard>
        <h2 className="font-bold text-sm mb-3">Billing alerts ({days}d)</h2>
        {alertRows.length === 0 ? (
          <p className="text-ink-muted text-xs">No payment failures or subscription cancellations in this window.</p>
        ) : (
          <div className="space-y-2">
            {alertRows.map((a) => {
              const t = one(a.tenants);
              return (
                <div key={a.id} className="flex items-center justify-between text-xs border-b border-white/10 last:border-0 pb-2 last:pb-0">
                  <div>
                    <div className="font-semibold">{t?.restaurant_name ?? '—'}</div>
                    <div className="text-ink-muted">{a.summary ?? a.type}</div>
                  </div>
                  <span className="text-ink-muted whitespace-nowrap">{new Date(a.received_at).toLocaleDateString()}</span>
                </div>
              );
            })}
          </div>
        )}
      </AdminCard>
    </div>
  );
}
