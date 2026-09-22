import { createControlPlaneServerClient } from '@/lib/supabase/control-plane-server';
import { gateAdminPage } from '@/lib/adminPermissions';
import { AdminStatCard, AdminCard } from '../_components/ui';
import {
  computeSaasMetrics,
  formatPct,
  type SubRow,
  type PlanLite,
  type TenantLite,
} from '@automation-restaurant/shared';

export const dynamic = 'force-dynamic';

type PlanChangeRow = {
  id: number;
  before: { tier?: string } | null;
  after: { tier?: string } | null;
  created_at: string;
};

/**
 * Every number on this page comes from computeSaasMetrics() (packages/shared/
 * src/saasMetrics.ts) — the Overview dashboard reads the exact same
 * function, so the two pages can never disagree about what "MRR" means.
 * subscriptions has no created_at column, only updated_at, so trial
 * conversion is an approximation keyed on updated_at (noted in its card).
 */
export default async function AdminAnalyticsPage() {
  const supabase = await createControlPlaneServerClient();
  await gateAdminPage(supabase, 'analytics.view');

  const [{ data: subs }, { data: plans }, { data: tenants }, { data: planChanges }] = await Promise.all([
    supabase.from('subscriptions').select('tier, billing_interval, status, updated_at, current_period_end'),
    supabase.from('plans').select('tier, name, price_monthly_cents, price_annual_cents'),
    supabase.from('tenants').select('id, owner_email, status, created_at'),
    supabase
      .from('audit_logs')
      .select('id, before, after, created_at')
      .eq('action', 'subscription.plan_changed')
      .order('created_at', { ascending: false })
      .limit(50),
  ]);

  const subRows = (subs ?? []) as SubRow[];
  const planRows = (plans ?? []) as PlanLite[];
  const tenantRows = (tenants ?? []) as TenantLite[];
  const planByTier = new Map(planRows.map((p) => [p.tier, p]));
  const m = computeSaasMetrics({ subs: subRows, plans: planRows, tenants: tenantRows });
  const changes = (planChanges ?? []) as PlanChangeRow[];

  const planOrder = new Map(planRows.map((p, i) => [p.tier, i]));
  const upgrades = changes.filter((c) => {
    const from = planOrder.get(c.before?.tier ?? '');
    const to = planOrder.get(c.after?.tier ?? '');
    return from != null && to != null && to > from;
  }).length;
  const downgrades = changes.filter((c) => {
    const from = planOrder.get(c.before?.tier ?? '');
    const to = planOrder.get(c.after?.tier ?? '');
    return from != null && to != null && to < from;
  }).length;

  return (
    <div className="space-y-8 max-w-5xl">
      <h1 className="text-xl font-black">Analytics</h1>

      <section className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <AdminStatCard label="MRR" value={`$${(m.mrrCents / 100).toLocaleString()}`} />
        <AdminStatCard label="ARR" value={`$${(m.arrCents / 100).toLocaleString()}`} />
        <AdminStatCard label="Active subscriptions" value={m.activeCount} tone="ok" />
        <AdminStatCard
          label="30-day churn"
          value={formatPct(m.churnRate)}
          tone={m.churnRate && m.churnRate > 0.1 ? 'danger' : 'default'}
        />
      </section>

      <section className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <AdminStatCard label="Trial conversion (30d, approx.)" value={formatPct(m.trialConversionRate)} tone="ok" />
        <AdminStatCard label="New restaurants (30d)" value={m.customerGrowth.newCount} />
        <AdminStatCard
          label="Failed payment rate"
          value={formatPct(m.failedPaymentRate)}
          tone={m.failedPaymentRate && m.failedPaymentRate > 0.05 ? 'danger' : 'default'}
        />
        <AdminStatCard label="Upgrades / downgrades" value={`${upgrades} / ${downgrades}`} />
      </section>

      <AdminCard>
        <h2 className="font-bold text-sm mb-3">Plan mix</h2>
        {m.planDistribution.size === 0 ? (
          <p className="text-ink-muted text-xs">No active subscriptions yet.</p>
        ) : (
          <div className="space-y-2">
            {[...m.planDistribution.entries()].sort((a, b) => b[1] - a[1]).map(([tier, count]) => (
              <div key={tier} className="flex items-center justify-between text-xs">
                <span className="font-semibold">{planByTier.get(tier)?.name ?? tier}</span>
                <span className="text-ink-muted">{count} restaurant{count === 1 ? '' : 's'}</span>
              </div>
            ))}
          </div>
        )}
      </AdminCard>

      <AdminCard>
        <h2 className="font-bold text-sm mb-3">Revenue by plan</h2>
        {m.revenueByPlan.size === 0 ? (
          <p className="text-ink-muted text-xs">No active subscriptions yet.</p>
        ) : (
          <div className="space-y-2">
            {[...m.revenueByPlan.entries()].sort((a, b) => b[1] - a[1]).map(([tier, cents]) => (
              <div key={tier} className="flex items-center justify-between text-xs">
                <span className="font-semibold">{planByTier.get(tier)?.name ?? tier}</span>
                <span className="text-ink-muted">${(cents / 100).toLocaleString()}/mo</span>
              </div>
            ))}
          </div>
        )}
      </AdminCard>

      <AdminCard>
        <h2 className="font-bold text-sm mb-3">Status breakdown</h2>
        <div className="space-y-2">
          {[...subRows.reduce((acc, r) => acc.set(r.status, (acc.get(r.status) ?? 0) + 1), new Map<string, number>()).entries()].map(
            ([status, count]) => (
              <div key={status} className="flex items-center justify-between text-xs">
                <span className="font-semibold capitalize">{status.replace('_', ' ')}</span>
                <span className="text-ink-muted">{count}</span>
              </div>
            ),
          )}
        </div>
      </AdminCard>
    </div>
  );
}
