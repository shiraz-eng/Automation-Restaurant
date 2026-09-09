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
