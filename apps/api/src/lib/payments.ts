import { randomBytes } from 'node:crypto';
import { PLANS, type PlanTier, type BillingInterval } from '@automation-restaurant/shared';

/**
 * Simulated payment for `PAYMENTS_MODE=mock` (the default when Stripe isn't
 * configured). It mirrors the shape of a real charge — a payment-intent-style
 * reference, an amount, a card brand/last4 — and is treated as verified
 * server-side, so the onboarding flow keeps its "provision only after payment"
 * gate with no external setup. No real money moves.
 */
export interface SimulatedPayment {
  reference: string;
  customer_reference: string;
  amount_cents: number;
  currency: 'usd';
  card_brand: string;
  card_last4: string;
  status: 'succeeded';
  paid_at: string;
}

export function simulatePayment(
  tier: PlanTier,
  interval: BillingInterval,
): SimulatedPayment {
  const info = PLANS[tier];
  const perMonth = interval === 'annual' ? info.priceAnnual : info.priceMonthly;
  const months = interval === 'annual' ? 12 : 1;
  const amount_cents = perMonth == null ? 0 : Math.round(perMonth * 100) * months;
  return {
    reference: `mock_pi_${randomBytes(12).toString('hex')}`,
    customer_reference: `mock_cus_${randomBytes(8).toString('hex')}`,
    amount_cents,
    currency: 'usd',
    card_brand: 'visa',
    card_last4: '4242',
    status: 'succeeded',
    paid_at: new Date().toISOString(),
  };
}
