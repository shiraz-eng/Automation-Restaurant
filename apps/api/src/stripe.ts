import Stripe from 'stripe';
import { env } from './env';
import type { BillingInterval, PlanTier } from '@automation-restaurant/shared';
import { getActivePlans } from './lib/plans';

// apiVersion intentionally omitted — the account's default pinned version is used,
// which keeps this from breaking when the stripe types package bumps.
export const stripe = new Stripe(env.STRIPE_SECRET_KEY);

export interface PriceMapping {
  tier: PlanTier;
  interval: BillingInterval;
}

/** Resolve a Stripe Price ID to a plan tier/interval, or undefined if unmapped.
 *  Reads public.plans (via getActivePlans' cache) instead of a separate
 *  STRIPE_PRICE_MAP env var — one source for "what a price ID means"
 *  instead of two that could drift. */
export async function tierFromPriceId(
  priceId: string | null | undefined,
): Promise<PriceMapping | undefined> {
  if (!priceId) return undefined;
  const plans = await getActivePlans();
  for (const p of plans) {
    if (p.stripePriceIdMonthly === priceId) return { tier: p.tier, interval: 'monthly' };
    if (p.stripePriceIdAnnual === priceId) return { tier: p.tier, interval: 'annual' };
  }
  return undefined;
}

/** Reverse lookup: the Price ID for a tier + interval, or undefined. */
export async function priceIdFor(
  tier: PlanTier,
  interval: BillingInterval,
): Promise<string | undefined> {
  const plans = await getActivePlans();
  const plan = plans.find((p) => p.tier === tier);
  if (!plan) return undefined;
  return interval === 'annual' ? (plan.stripePriceIdAnnual ?? undefined) : (plan.stripePriceIdMonthly ?? undefined);
}

/** True only when a real secret key is configured. Individual plans may
 *  still lack a Stripe price (e.g. Enterprise, or a newly-added plan before
 *  its price is set) — priceIdFor returning undefined for THAT plan is the
 *  per-plan signal, this flag is just "is Stripe usable at all". */
export const billingConfigured = /^sk_(test|live)_/.test(env.STRIPE_SECRET_KEY);

interface CheckoutInput {
  priceId: string;
  customerEmail: string;
  successUrl: string;
  cancelUrl: string;
  metadata: Record<string, string>;
}

/** Create a subscription Checkout Session. The tenant is NOT created here —
 *  that happens in the verified webhook after payment succeeds. */
export function createSubscriptionCheckout(input: CheckoutInput) {
  return stripe.checkout.sessions.create({
    mode: 'subscription',
    line_items: [{ price: input.priceId, quantity: 1 }],
    customer_email: input.customerEmail,
    success_url: input.successUrl,
    cancel_url: input.cancelUrl,
    metadata: input.metadata,
    subscription_data: { metadata: input.metadata },
    allow_promotion_codes: true,
  });
}
