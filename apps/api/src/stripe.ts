import Stripe from 'stripe';
import { env } from './env';
import {
  isBillingInterval,
  isPlanTier,
  type BillingInterval,
  type PlanTier,
} from '@automation-restaurant/shared';

// apiVersion intentionally omitted — the account's default pinned version is used,
// which keeps this from breaking when the stripe types package bumps.
export const stripe = new Stripe(env.STRIPE_SECRET_KEY);

export interface PriceMapping {
  tier: PlanTier;
  interval?: BillingInterval;
}

const priceMap = new Map<string, PriceMapping>();
for (const raw of env.STRIPE_PRICE_MAP.split(',')) {
  const entry = raw.trim();
  if (!entry) continue;
  const [priceId, tier, interval] = entry.split(':').map((s) => s.trim());
  if (!priceId || !isPlanTier(tier)) {
    console.warn(`[stripe] ignoring malformed STRIPE_PRICE_MAP entry: "${entry}"`);
    continue;
  }
  priceMap.set(priceId, {
    tier,
    interval: isBillingInterval(interval) ? interval : undefined,
  });
}

/** Resolve a Stripe Price ID to a plan tier/interval, or undefined if unmapped. */
export function tierFromPriceId(priceId: string | null | undefined): PriceMapping | undefined {
  return priceId ? priceMap.get(priceId) : undefined;
}

/** Reverse lookup: the Price ID for a tier + interval, or undefined. */
export function priceIdFor(
  tier: PlanTier,
  interval: BillingInterval,
): string | undefined {
  for (const [priceId, m] of priceMap) {
    if (m.tier === tier && (m.interval ?? interval) === interval) return priceId;
  }
  return undefined;
}

/** True only when a real secret key AND at least one price mapping are present. */
export const billingConfigured =
  /^sk_(test|live)_/.test(env.STRIPE_SECRET_KEY) && priceMap.size > 0;

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
