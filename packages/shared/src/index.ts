/**
 * Single source of truth for subscription/plan TYPES and feature-entitlement
 * logic, shared by the API and web app so the two never disagree about what
 * a plan includes. Plan DATA (tiers, prices, features, highlights) used to
 * live here as a static PLANS/PLAN_FEATURES constant; it now lives in the
 * control plane's public.plans table (supabase/control-plane/0009_plans_admin.sql)
 * so an admin can edit it without a code deploy — fetched at runtime via
 * apps/api/src/lib/plans.ts (server) / apps/web/src/lib/plans.ts (browser),
 * both returning the PlanRow shape defined below.
 */

// A plan tier is now an admin-editable string key (public.plans.tier), not a
// fixed set — a new plan can be added without a code change. isPlanTier is
// a narrowing/shape check only; whether a tier actually exists is decided by
// looking it up in a fetched plans list (getPlanByTier), never by this.
export type PlanTier = string;
export type BillingInterval = 'monthly' | 'annual';
export type SubscriptionStatus =
  | 'trialing'
  | 'active'
  | 'past_due'
  | 'canceled'
  | 'incomplete';

export function isPlanTier(value: unknown): value is PlanTier {
  return typeof value === 'string' && value.trim().length > 0;
}

export function isBillingInterval(value: unknown): value is BillingInterval {
  return value === 'monthly' || value === 'annual';
}

// Fixed capability keys the app knows how to gate. Admin-editable per-plan
// (public.plans.features stores a subset of these), but the set of keys
// itself is NOT admin-editable — a capability only belongs here once the app
// actually implements it, otherwise a checkbox would gate nothing real.
export type FeatureKey =
  | 'pos.multi_terminal'
  | 'kds.realtime'
  | 'kds.station_routing'
  | 'inventory.recipe_deduction'
  | 'inventory.predictive_ai'
  | 'menu.branded'
  | 'menu.white_label'
  | 'sync.offline_6h'
  | 'sync.mesh'
  | 'branches.multi';

export const ALL_FEATURE_KEYS: readonly FeatureKey[] = [
  'pos.multi_terminal',
  'kds.realtime',
  'kds.station_routing',
  'inventory.recipe_deduction',
  'inventory.predictive_ai',
  'menu.branded',
  'menu.white_label',
  'sync.offline_6h',
  'sync.mesh',
  'branches.multi',
];

/** The subset of FeatureKey with real, working functionality behind it
 *  today, safe to actually gate. The other 6 keys are pricing-page
 *  marketing copy only — toggling them on a plan changes what's *displayed*,
 *  never what's enforced. Confirmed by direct investigation of every key
 *  against the live codebase (see the SaaS platform build plan). */
export const ENFORCEABLE_FEATURES: readonly FeatureKey[] = [
  'kds.realtime',
  'kds.station_routing',
  'inventory.recipe_deduction',
  'menu.branded',
];

/** A row from public.plans (control plane) — the shape both apps' plan
 *  helpers (apps/api/src/lib/plans.ts, apps/web/src/lib/plans.ts) fetch and
 *  return. null price = "contact sales", matching Enterprise. */
export interface PlanRow {
  id: string;
  tier: PlanTier;
  name: string;
  blurb: string | null;
  priceMonthlyCents: number | null;
  priceAnnualCents: number | null;
  currency: string;
  limits: { users?: string; branches?: string; tables?: string; support?: string };
  highlights: string[];
  features: FeatureKey[];
  stripePriceIdMonthly: string | null;
  stripePriceIdAnnual: string | null;
  isActive: boolean;
  sortOrder: number;
}

/** Subscription statuses that entitle a tenant to their plan's features. */
export const ENTITLED_STATUSES: readonly SubscriptionStatus[] = ['active', 'trialing'];

export function isEntitled(status: SubscriptionStatus): boolean {
  return ENTITLED_STATUSES.includes(status);
}

/** A feature is available only when the subscription is live AND the plan
 *  includes it. `plan` is null when the tenant's plan couldn't be resolved
 *  (never treated as entitled). */
export function hasFeature(
  plan: PlanRow | null | undefined,
  status: SubscriptionStatus,
  feature: FeatureKey,
): boolean {
  return isEntitled(status) && !!plan && plan.features.includes(feature);
}

export * from './saasMetrics';
