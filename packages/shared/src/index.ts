/**
 * Single source of truth for subscription tiers and feature entitlements.
 * Imported by the API (route gating) and, later, the web app (UI gating) so the
 * two can never disagree about what a plan includes.
 */

export type PlanTier = 'starter' | 'growth' | 'enterprise';
export type BillingInterval = 'monthly' | 'annual';
export type SubscriptionStatus =
  | 'trialing'
  | 'active'
  | 'past_due'
  | 'canceled'
  | 'incomplete';

export const PLAN_TIERS: readonly PlanTier[] = ['starter', 'growth', 'enterprise'];

export function isPlanTier(value: unknown): value is PlanTier {
  return typeof value === 'string' && (PLAN_TIERS as readonly string[]).includes(value);
}

export function isBillingInterval(value: unknown): value is BillingInterval {
  return value === 'monthly' || value === 'annual';
}

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

/** Flat feature list per tier. Higher tiers repeat lower-tier features explicitly. */
export const PLAN_FEATURES: Record<PlanTier, readonly FeatureKey[]> = {
  starter: [],
  growth: [
    'pos.multi_terminal',
    'kds.realtime',
    'inventory.recipe_deduction',
    'menu.branded',
    'sync.offline_6h',
  ],
  enterprise: [
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
  ],
};

export interface PlanInfo {
  tier: PlanTier;
  name: string;
  blurb: string;
  /** USD per month; null = contact sales */
  priceMonthly: number | null;
  /** USD per month, billed annually; null = contact sales */
  priceAnnual: number | null;
  limits: { users: string; branches: string; tables: string; support: string };
  /** Human-readable module list shown on the pricing card. */
  highlights: string[];
}

export const PLANS: Record<PlanTier, PlanInfo> = {
  starter: {
    tier: 'starter',
    name: 'Starter',
    blurb: 'For small restaurants and cafés.',
    priceMonthly: 49,
    priceAnnual: 39,
    limits: { users: '5', branches: '1', tables: '20', support: 'Email' },
    highlights: ['POS & orders', 'QR table ordering', 'Tables & floor', 'Basic reports'],
  },
  growth: {
    tier: 'growth',
    name: 'Professional',
    blurb: 'For growing restaurants.',
    priceMonthly: 129,
    priceAnnual: 103,
    limits: { users: '20', branches: '1', tables: 'Unlimited', support: 'Priority' },
    highlights: [
      'Everything in Starter',
      'Kitchen display + real-time',
      'Inventory & recipes',
      'Staff, customers, reservations',
      'Advanced analytics',
    ],
  },
  enterprise: {
    tier: 'enterprise',
    name: 'Enterprise',
    blurb: 'For multi-branch restaurant groups.',
    priceMonthly: null,
    priceAnnual: null,
    limits: { users: 'Unlimited', branches: 'Unlimited', tables: 'Unlimited', support: 'Dedicated' },
    highlights: [
      'Everything in Professional',
      'Multi-branch management',
      'Accounting',
      'Custom branding',
      'Advanced permissions',
      'Enterprise support',
    ],
  },
};

/** Subscription statuses that entitle a tenant to their plan's features. */
export const ENTITLED_STATUSES: readonly SubscriptionStatus[] = ['active', 'trialing'];

export function isEntitled(status: SubscriptionStatus): boolean {
  return ENTITLED_STATUSES.includes(status);
}

/** A feature is available only when the subscription is live AND the tier includes it. */
export function hasFeature(
  tier: PlanTier,
  status: SubscriptionStatus,
  feature: FeatureKey,
): boolean {
  return isEntitled(status) && PLAN_FEATURES[tier].includes(feature);
}
