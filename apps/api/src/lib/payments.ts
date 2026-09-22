import { randomBytes, createHmac, timingSafeEqual } from 'node:crypto';
import type { PlanTier, BillingInterval } from '@automation-restaurant/shared';
import { env } from '../env';
import { getPlanByTier } from './plans';

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

export async function amountForPlan(tier: PlanTier, interval: BillingInterval): Promise<number> {
  const plan = await getPlanByTier(tier);
  const perMonthCents = interval === 'annual' ? plan?.priceAnnualCents : plan?.priceMonthlyCents;
  const months = interval === 'annual' ? 12 : 1;
  return perMonthCents == null ? 0 : perMonthCents * months;
}

function detectBrand(pan: string): string {
  if (/^4/.test(pan)) return 'visa';
  if (/^5[1-5]/.test(pan) || /^2[2-7]/.test(pan)) return 'mastercard';
  if (/^3[47]/.test(pan)) return 'amex';
  if (/^6/.test(pan)) return 'discover';
  return 'card';
}

function luhnValid(pan: string): boolean {
  if (!/^\d{12,19}$/.test(pan)) return false;
  let sum = 0;
  let dbl = false;
  for (let i = pan.length - 1; i >= 0; i--) {
    let d = pan.charCodeAt(i) - 48;
    if (dbl && (d *= 2) > 9) d -= 9;
    sum += d;
    dbl = !dbl;
  }
  return sum % 10 === 0;
}

export interface CardInput {
  number: string;
  exp_month: number;
  exp_year: number;
  cvc: string;
}

/** Validate a card the way a gateway would in test mode (format only — never
 *  stored). Returns the brand/last4 on success. */
export function validateCard(
  card: CardInput,
): { ok: true; brand: string; last4: string } | { ok: false; reason: string } {
  const pan = card.number.replace(/[\s-]/g, '');
  if (!luhnValid(pan)) return { ok: false, reason: 'Your card number is invalid.' };
  const now = new Date();
  const exp = new Date(card.exp_year, card.exp_month, 0, 23, 59, 59);
  if (!(card.exp_month >= 1 && card.exp_month <= 12) || exp < now) {
    return { ok: false, reason: 'Your card has expired.' };
  }
  if (!/^\d{3,4}$/.test(card.cvc)) return { ok: false, reason: "Your card's security code is incomplete." };
  return { ok: true, brand: detectBrand(pan), last4: pan.slice(-4) };
}

export async function simulatePayment(
  tier: PlanTier,
  interval: BillingInterval,
  card?: { brand: string; last4: string },
): Promise<SimulatedPayment> {
  return {
    reference: `mock_pi_${randomBytes(12).toString('hex')}`,
    customer_reference: `mock_cus_${randomBytes(8).toString('hex')}`,
    amount_cents: await amountForPlan(tier, interval),
    currency: 'usd',
    card_brand: card?.brand ?? 'visa',
    card_last4: card?.last4 ?? '4242',
    status: 'succeeded',
    paid_at: new Date().toISOString(),
  };
}

// ── Stateless checkout intent (mock mode) ──────────────────────────────────
// The signup form's data is HMAC-signed into a token carried through the card
// page, so no pending-checkout row is stored anywhere.
const INTENT_TTL_MS = 30 * 60_000;

export interface CheckoutIntent {
  restaurant_name: string;
  owner_name?: string;
  owner_email: string;
  phone?: string;
  country?: string;
  address?: string;
  branch_name?: string;
  table_count?: number;
  plan: PlanTier;
  billing_interval: BillingInterval;
  iat: number;
}

function hmac(data: string): Buffer {
  return createHmac('sha256', env.SUPABASE_SERVICE_ROLE_KEY).update(data).digest();
}

export function signCheckoutIntent(intent: Omit<CheckoutIntent, 'iat'>): string {
  const body = Buffer.from(JSON.stringify({ ...intent, iat: Date.now() })).toString('base64url');
  return `${body}.${hmac(body).toString('base64url')}`;
}

export function verifyCheckoutIntent(token: string): CheckoutIntent | null {
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  const expected = hmac(body);
  let given: Buffer;
  try {
    given = Buffer.from(sig, 'base64url');
  } catch {
    return null;
  }
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const intent = JSON.parse(Buffer.from(body, 'base64url').toString()) as CheckoutIntent;
    if (Date.now() - intent.iat > INTENT_TTL_MS) return null;
    return intent;
  } catch {
    return null;
  }
}
