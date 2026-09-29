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
  | 'staff.management'
  | 'analytics.advanced'
  | 'accounting.finance'
  | 'portals.advanced'
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
  'staff.management',
  'analytics.advanced',
  'accounting.finance',
  'portals.advanced',
  'menu.branded',
  'menu.white_label',
  'sync.offline_6h',
  'sync.mesh',
  'branches.multi',
];

export const ENFORCEABLE_FEATURES: readonly FeatureKey[] = [
  'kds.realtime',
  'kds.station_routing',
  'inventory.recipe_deduction',
  'staff.management',
  'analytics.advanced',
  'accounting.finance',
  'portals.advanced',
  'menu.branded',
  'branches.multi',
];

export const PLAN_TIER_DEFAULT_FEATURES: Record<string, FeatureKey[]> = {
  starter: ['pos.multi_terminal'],
  growth: [
    'pos.multi_terminal',
    'kds.realtime',
    'inventory.recipe_deduction',
    'staff.management',
    'analytics.advanced',
  ],
  enterprise: [
    'pos.multi_terminal',
    'kds.realtime',
    'kds.station_routing',
    'inventory.recipe_deduction',
    'inventory.predictive_ai',
    'staff.management',
    'analytics.advanced',
    'accounting.finance',
    'portals.advanced',
    'menu.branded',
    'menu.white_label',
    'sync.offline_6h',
    'sync.mesh',
    'branches.multi',
  ],
};

export type FeatureMeta = {
  key: FeatureKey;
  name: string;
  minTier: 'starter' | 'growth' | 'enterprise';
  minTierName: 'Starter' | 'Professional' | 'Enterprise';
  description: string;
};

export const FEATURE_METADATA: Record<FeatureKey, FeatureMeta> = {
  'kds.realtime': {
    key: 'kds.realtime',
    name: 'Kitchen Display System (KDS)',
    minTier: 'growth',
    minTierName: 'Professional',
    description: 'Real-time kitchen order tickets, order timers, course coordination, and live prep status.',
  },
  'kds.station_routing': {
    key: 'kds.station_routing',
    name: 'KDS Station Routing',
    minTier: 'enterprise',
    minTierName: 'Enterprise',
    description: 'Route specific food and drink items to separate kitchen stations, bars, and prep lines automatically.',
  },
  'inventory.recipe_deduction': {
    key: 'inventory.recipe_deduction',
    name: 'Inventory & Recipe Management',
    minTier: 'growth',
    minTierName: 'Professional',
    description: 'Ingredient tracking, automatic stock deduction on sales, recipe cost calculation, purchase orders, and supplier management.',
  },
  'inventory.predictive_ai': {
    key: 'inventory.predictive_ai',
    name: 'Predictive Inventory AI',
    minTier: 'enterprise',
    minTierName: 'Enterprise',
    description: 'AI-assisted demand forecasting, automated reorder recommendations, and waste anomaly detection.',
  },
  'staff.management': {
    key: 'staff.management',
    name: 'Staff & Shift Scheduling',
    minTier: 'growth',
    minTierName: 'Professional',
    description: 'Staff member directory, role-based access, shift scheduling, clock-in/out attendance, and customer review tracking.',
  },
  'analytics.advanced': {
    key: 'analytics.advanced',
    name: 'Advanced Analytics & AI Assistant',
    minTier: 'growth',
    minTierName: 'Professional',
    description: 'Multi-sheet workbook exports, audit logs, AI business assistant, and conversational report generation.',
  },
  'accounting.finance': {
    key: 'accounting.finance',
    name: 'Accounting & Profit Analytics',
    minTier: 'enterprise',
    minTierName: 'Enterprise',
    description: 'Full financial accounting, operating expenses tracking, authoritative Profit & Loss (P&L) waterfall statements, and PDF reports.',
  },
  'portals.advanced': {
    key: 'portals.advanced',
    name: 'Custom Station & Kiosk Portals',
    minTier: 'enterprise',
    minTierName: 'Enterprise',
    description: 'Create independent, password-protected kiosk portals for waiters, kitchen stations, cashiers, and host stands.',
  },
  'menu.branded': {
    key: 'menu.branded',
    name: 'Custom Branding & White Label',
    minTier: 'enterprise',
    minTierName: 'Enterprise',
    description: 'Upload custom restaurant logo, configure brand theme colors, customize printed receipt templates, and custom meta titles.',
  },
  'menu.white_label': {
    key: 'menu.white_label',
    name: 'Full White Labeling',
    minTier: 'enterprise',
    minTierName: 'Enterprise',
    description: 'Remove Automation Restaurant branding across guest menus, customer portals, receipts, and order tracking.',
  },
  'pos.multi_terminal': {
    key: 'pos.multi_terminal',
    name: 'Multi-Terminal POS',
    minTier: 'starter',
    minTierName: 'Starter',
    description: 'Run multiple point-of-sale order terminals simultaneously.',
  },
  'sync.offline_6h': {
    key: 'sync.offline_6h',
    name: 'Offline Resilience',
    minTier: 'enterprise',
    minTierName: 'Enterprise',
    description: 'Keep taking orders and syncing payments even during internet outages.',
  },
  'sync.mesh': {
    key: 'sync.mesh',
    name: 'Mesh Network Sync',
    minTier: 'enterprise',
    minTierName: 'Enterprise',
    description: 'Local device peer-to-peer sync without an active external connection.',
  },
  'branches.multi': {
    key: 'branches.multi',
    name: 'Multi-Branch Management',
    minTier: 'enterprise',
    minTierName: 'Enterprise',
    description: 'Centrally manage multiple restaurant branches, shared menus, cross-location inventory, and aggregated reports.',
  },
};

export function isTierEntitledToFeature(
  tier: string | null | undefined,
  feature: FeatureKey,
  explicitFeatures?: FeatureKey[] | null,
): boolean {
  if (!tier) return true; // Fail open in dev or unprovisioned state
  const norm = tier.toLowerCase();
  if (norm === 'enterprise') return true;

  if (explicitFeatures && explicitFeatures.length > 0 && explicitFeatures.includes(feature)) {
    return true;
  }

  const defaults =
    PLAN_TIER_DEFAULT_FEATURES[norm] ||
    (norm === 'pro' || norm === 'professional' ? PLAN_TIER_DEFAULT_FEATURES.growth : undefined);
  if (defaults && defaults.includes(feature)) {
    return true;
  }

  return false;
}

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
  if (!isEntitled(status)) return false;
  if (!plan) return false;
  return isTierEntitledToFeature(plan.tier, feature, plan.features);
}

export * from './saasMetrics';
