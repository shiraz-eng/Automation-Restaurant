import { supabaseAdmin } from '../supabase';
import { env, stripeConfigured } from '../env';
import type { FeatureKey, PlanRow } from '@automation-restaurant/shared';

/**
 * The one place server-side code resolves plan/pricing data — reads
 * public.plans on the control plane (supabase/control-plane/0009_plans_admin.sql),
 * which replaced the old static packages/shared PLANS constant so an admin
 * can edit plans without a deploy. Short in-memory cache since this is read
 * on essentially every request that touches billing/entitlements.
 */

type PlanDbRow = {
  id: string;
  tier: string;
  name: string;
  blurb: string | null;
  price_monthly_cents: number | null;
  price_annual_cents: number | null;
  currency: string;
  limits: Record<string, string>;
  highlights: string[];
  features: string[];
  stripe_price_id_monthly: string | null;
  stripe_price_id_annual: string | null;
  is_active: boolean;
  sort_order: number;
};

function toPlanRow(r: PlanDbRow): PlanRow {
  return {
    id: r.id,
    tier: r.tier,
    name: r.name,
    blurb: r.blurb,
    priceMonthlyCents: r.price_monthly_cents,
    priceAnnualCents: r.price_annual_cents,
    currency: r.currency,
    limits: r.limits ?? {},
    highlights: r.highlights ?? [],
    features: (r.features ?? []) as FeatureKey[],
    stripePriceIdMonthly: r.stripe_price_id_monthly,
    stripePriceIdAnnual: r.stripe_price_id_annual,
    isActive: r.is_active,
    sortOrder: r.sort_order,
  };
}

const CACHE_TTL_MS = 60_000;
let cache: { at: number; rows: PlanRow[] } | null = null;

async function fetchActivePlans(): Promise<PlanRow[]> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.rows;
  const { data, error } = await supabaseAdmin
    .from('plans')
    .select('*')
    .eq('is_active', true)
    .order('sort_order');
  if (error) throw error;
  const rows = ((data ?? []) as PlanDbRow[]).map(toPlanRow);
  cache = { at: Date.now(), rows };
  return rows;
}

/** Active plans, cheapest/first-configured first. */
export async function getActivePlans(): Promise<PlanRow[]> {
  return fetchActivePlans();
}

/** A single active plan by tier, or undefined if no active plan has it. */
export async function getPlanByTier(tier: string): Promise<PlanRow | undefined> {
  const plans = await fetchActivePlans();
  return plans.find((p) => p.tier === tier);
}

/** Invalidate the cache immediately — call after an admin write to public.plans
 *  so the change is visible without waiting out the TTL. */
export function invalidatePlansCache(): void {
  cache = null;
}

/**
 * Effective payment mode. 'auto' (the default) picks Stripe only when it's
 * both configured (a real secret key) AND actually usable (at least one
 * active plan has a Stripe price set) — same "auto falls back to mock unless
 * fully wired" behavior env.ts's old static check had, just sourced from
 * public.plans instead of the STRIPE_PRICE_MAP env var, so it needs a DB
 * read and can't be a module-load-time constant any more.
 */
export async function resolvePaymentsMode(): Promise<'stripe' | 'mock'> {
  if (env.PAYMENTS_MODE !== 'auto') return env.PAYMENTS_MODE;
  if (!stripeConfigured) return 'mock';
  const plans = await getActivePlans();
  const hasAnyPrice = plans.some((p) => p.stripePriceIdMonthly || p.stripePriceIdAnnual);
  return hasAnyPrice ? 'stripe' : 'mock';
}
