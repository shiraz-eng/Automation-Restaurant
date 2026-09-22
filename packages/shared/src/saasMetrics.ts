/**
 * Single source of truth for every platform-level SaaS metric (MRR, ARR,
 * churn, trial conversion, plan distribution, revenue by plan, customer
 * growth, failed-payment rate, and the Customers-directory owner grouping).
 * Both the admin Overview dashboard and the Analytics page call into this
 * module instead of each computing their own version of "MRR" — the two
 * must never be able to disagree. Pure functions over already-fetched rows
 * (raw snake_case shapes matching the control-plane `subscriptions`/`plans`/
 * `tenants` tables directly, since that's what the admin pages already
 * fetch via RLS) so this file has no Supabase/Express/Next dependency and
 * can be called from both apps.
 */

export type SubStatus = 'trialing' | 'active' | 'past_due' | 'canceled' | 'incomplete';

export type SubRow = {
  tier: string;
  billing_interval: 'monthly' | 'annual';
  status: SubStatus | string;
  current_period_end?: string | null;
  updated_at: string;
  created_at?: string;
};

export type PlanLite = {
  tier: string;
  name: string;
  price_monthly_cents: number | null;
  price_annual_cents: number | null;
};

export type TenantLite = {
  id: string;
  owner_email: string | null;
  status: string;
  created_at: string;
};

const LIVE_STATUSES = new Set(['active', 'trialing']);

export function planPriceCents(sub: Pick<SubRow, 'tier' | 'billing_interval'>, plans: PlanLite[]): number | null {
  const plan = plans.find((p) => p.tier === sub.tier);
  if (!plan) return null;
  return sub.billing_interval === 'annual' ? plan.price_annual_cents : plan.price_monthly_cents;
}

export function computeMrrCents(subs: SubRow[], plans: PlanLite[]): number {
  let cents = 0;
  for (const s of subs) {
    if (!LIVE_STATUSES.has(s.status)) continue;
    const price = planPriceCents(s, plans);
    if (price != null) cents += price;
  }
  return cents;
}

export function computeArrCents(mrrCents: number): number {
  return mrrCents * 12;
}

export function computeChurnRate(subs: SubRow[], windowDays = 30): number | null {
  const cutoff = Date.now() - windowDays * 24 * 60 * 60 * 1000;
  const activeCount = subs.filter((s) => LIVE_STATUSES.has(s.status)).length;
  const canceledInWindow = subs.filter(
    (s) => s.status === 'canceled' && new Date(s.updated_at).getTime() >= cutoff,
  ).length;
  const denom = activeCount + canceledInWindow;
  return denom > 0 ? canceledInWindow / denom : null;
}

/** Share of trials started in the window that are now active (converted)
 *  vs canceled/incomplete (lost) — trials still `trialing` are excluded
 *  from the denominator since they haven't resolved yet. */
export function computeTrialConversionRate(subs: SubRow[], windowDays = 30): number | null {
  const cutoff = Date.now() - windowDays * 24 * 60 * 60 * 1000;
  const resolved = subs.filter((s) => {
    const started = new Date(s.created_at ?? s.updated_at).getTime();
    return started >= cutoff && s.status !== 'trialing';
  });
  if (resolved.length === 0) return null;
  const converted = resolved.filter((s) => s.status === 'active').length;
  return converted / resolved.length;
}

export function computePlanDistribution(subs: SubRow[]): Map<string, number> {
  const dist = new Map<string, number>();
  for (const s of subs) {
    if (!LIVE_STATUSES.has(s.status)) continue;
    dist.set(s.tier, (dist.get(s.tier) ?? 0) + 1);
  }
  return dist;
}

export function computeRevenueByPlan(subs: SubRow[], plans: PlanLite[]): Map<string, number> {
  const rev = new Map<string, number>();
  for (const s of subs) {
    if (!LIVE_STATUSES.has(s.status)) continue;
    const price = planPriceCents(s, plans);
    if (price != null) rev.set(s.tier, (rev.get(s.tier) ?? 0) + price);
  }
  return rev;
}

export function computeCustomerGrowth(
  tenants: TenantLite[],
  windowDays = 30,
): { newCount: number; totalActive: number } {
  const cutoff = Date.now() - windowDays * 24 * 60 * 60 * 1000;
  const newCount = tenants.filter((t) => new Date(t.created_at).getTime() >= cutoff).length;
  const totalActive = tenants.filter((t) => t.status === 'active').length;
  return { newCount, totalActive };
}

export function computeFailedPaymentRate(subs: SubRow[], windowDays = 30): number | null {
  const cutoff = Date.now() - windowDays * 24 * 60 * 60 * 1000;
  const relevant = subs.filter(
    (s) => LIVE_STATUSES.has(s.status) || (s.status === 'past_due' && new Date(s.updated_at).getTime() >= cutoff),
  );
  if (relevant.length === 0) return null;
  const failed = relevant.filter((s) => s.status === 'past_due').length;
  return failed / relevant.length;
}

export type CustomerAccount = {
  ownerEmail: string;
  tenantIds: string[];
  restaurantNames: string[];
  restaurantCount: number;
  mrrCents: number;
  hasActive: boolean;
  hasPastDue: boolean;
};

/** Groups tenants by owner_email — a "Customer" is one owner, who may own
 *  several restaurants (confirmed real in this platform's data). */
export function groupByOwner(
  tenants: (TenantLite & { id: string; restaurant_name?: string })[],
  subsByTenantId: Map<string, SubRow[]>,
  plans: PlanLite[],
): CustomerAccount[] {
  const byOwner = new Map<string, CustomerAccount>();
  for (const t of tenants) {
    const owner = t.owner_email ?? '(no owner email)';
    const subs = subsByTenantId.get(t.id) ?? [];
    const acc = byOwner.get(owner) ?? {
      ownerEmail: owner,
      tenantIds: [],
      restaurantNames: [],
      restaurantCount: 0,
      mrrCents: 0,
      hasActive: false,
      hasPastDue: false,
    };
    acc.tenantIds.push(t.id);
    if (t.restaurant_name) acc.restaurantNames.push(t.restaurant_name);
    acc.restaurantCount += 1;
    acc.mrrCents += computeMrrCents(subs, plans);
    if (subs.some((s) => LIVE_STATUSES.has(s.status))) acc.hasActive = true;
    if (subs.some((s) => s.status === 'past_due')) acc.hasPastDue = true;
    byOwner.set(owner, acc);
  }
  return [...byOwner.values()].sort((a, b) => b.mrrCents - a.mrrCents);
}

export type SaasMetrics = {
  mrrCents: number;
  arrCents: number;
  activeCount: number;
  churnRate: number | null;
  trialConversionRate: number | null;
  planDistribution: Map<string, number>;
  revenueByPlan: Map<string, number>;
  failedPaymentRate: number | null;
  customerGrowth: { newCount: number; totalActive: number };
};

/** Consistent percent formatting for every metric card across Overview/Analytics. */
export function formatPct(rate: number | null): string {
  return rate == null ? '—' : `${(rate * 100).toFixed(1)}%`;
}

export function computeSaasMetrics(input: {
  subs: SubRow[];
  plans: PlanLite[];
  tenants: TenantLite[];
}): SaasMetrics {
  const mrrCents = computeMrrCents(input.subs, input.plans);
  return {
    mrrCents,
    arrCents: computeArrCents(mrrCents),
    activeCount: input.subs.filter((s) => LIVE_STATUSES.has(s.status)).length,
    churnRate: computeChurnRate(input.subs),
    trialConversionRate: computeTrialConversionRate(input.subs),
    planDistribution: computePlanDistribution(input.subs),
    revenueByPlan: computeRevenueByPlan(input.subs, input.plans),
    failedPaymentRate: computeFailedPaymentRate(input.subs),
    customerGrowth: computeCustomerGrowth(input.tenants),
  };
}
