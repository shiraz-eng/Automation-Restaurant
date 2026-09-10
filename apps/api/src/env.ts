import { resolve } from 'node:path';
import { config } from 'dotenv';
import { z } from 'zod';

config({
  path: [
    resolve(process.cwd(), 'apps/api/.env'),
    resolve(process.cwd(), '.env'),
    resolve(__dirname, '../.env'),
    resolve(__dirname, '../../.env'),
  ],
});

const schema = z.object({
  PORT: z.coerce.number().int().positive().default(4000),
  APP_URL: z.string().url(),

  // Control-plane Supabase project (the registry).
  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),

  // Supabase Management API — platform personal access token. One token spans
  // every organization the account owns, so the org pool below needs no extra
  // credentials.
  SUPABASE_ACCESS_TOKEN: z.string().min(1, 'Management API personal access token'),
  // Single org (paid plan). Also the fallback when SUPABASE_ORG_IDS is unset.
  SUPABASE_ORG_ID: z.string().min(1, 'Supabase organization id'),
  // Org pool for free-tier scaling: comma-separated org ids. Provisioning tries
  // each in order and moves on when one is at its 2-project cap. Leave blank to
  // use just SUPABASE_ORG_ID (the right choice on a paid plan).
  SUPABASE_ORG_IDS: z.string().trim().optional(),
  // Extra org ids that belong to us — a restaurant owner may not authorize
  // these in the connect flow. SUPABASE_ORG_ID + the pool are always included.
  SUPABASE_RESERVED_ORG_IDS: z.string().trim().optional(),
  SUPABASE_REGION: z.string().min(1).default('us-east-1'),
  SUPABASE_PROJECT_PLAN: z.enum(['free', 'pro']).default('free'),

  // Supabase OAuth app ("Connect your Supabase" / Model B). When all three are
  // set, checkout parks the tenant at status='awaiting_connection' and the owner
  // authorises our app against their OWN Supabase org; provisioning then runs
  // with their token. Leave blank to keep the legacy platform-org flow.
  SUPABASE_OAUTH_CLIENT_ID: z.string().trim().optional(),
  SUPABASE_OAUTH_CLIENT_SECRET: z.string().trim().optional(),
  SUPABASE_OAUTH_REDIRECT_URI: z
    .string()
    .url()
    .default('http://localhost:4000/api/onboarding/connect/callback'),

  // 'auto' (default) uses real Stripe when it's configured, otherwise a built-in
  // simulated payment so the flow runs with zero setup. 'stripe' / 'mock' force it.
  PAYMENTS_MODE: z.enum(['auto', 'stripe', 'mock']).default('auto'),
  STRIPE_SECRET_KEY: z.string().min(1),
  STRIPE_WEBHOOK_SECRET: z.string().min(1),
  // "priceId:tier:interval" comma-separated, e.g.
  // price_123:starter:monthly,price_456:starter:annual,price_789:growth:monthly
  STRIPE_PRICE_MAP: z.string().default(''),
  // Where Stripe returns the customer after checkout (defaults to APP_URL).
  CHECKOUT_RETURN_URL: z.string().url().optional(),

  ONBOARDING_TOKEN_TTL_MINUTES: z.coerce.number().int().positive().default(30),

  // ── Transactional email (welcome email etc.) ──────────────────────────────
  // Resend is used when RESEND_API_KEY is set; otherwise emails are logged to
  // the server console and recorded as 'skipped' (never silently "sent").
  RESEND_API_KEY: z.string().trim().optional(),
  EMAIL_FROM: z.string().trim().default('Automation Restaurant <onboarding@automationrestaurant.app>'),
  SUPPORT_EMAIL: z.string().trim().default('support@automationrestaurant.app'),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error('Invalid environment configuration:');
  console.error(JSON.stringify(parsed.error.flatten().fieldErrors, null, 2));
  process.exit(1);
}

export const env = parsed.data;

/** True when the "Connect your Supabase" OAuth flow is fully configured. */
export const oauthConnectEnabled = Boolean(
  env.SUPABASE_OAUTH_CLIENT_ID && env.SUPABASE_OAUTH_CLIENT_SECRET,
);

/** Real Stripe is usable (secret key + at least one price mapping). */
const stripeConfigured =
  /^sk_(test|live)_/.test(env.STRIPE_SECRET_KEY) && env.STRIPE_PRICE_MAP.trim().length > 0;

/**
 * Effective payment mode. 'auto' picks Stripe when configured, else 'mock' — a
 * self-contained simulated payment (random reference in payment format,
 * verified server-side) so onboarding works end-to-end with no external setup.
 */
export const paymentsMode: 'stripe' | 'mock' =
  env.PAYMENTS_MODE === 'auto' ? (stripeConfigured ? 'stripe' : 'mock') : env.PAYMENTS_MODE;

/**
 * Ordered list of Supabase organization ids to provision tenant projects into.
 * From SUPABASE_ORG_IDS if set, else the single SUPABASE_ORG_ID. Deduped.
 */
export const supabaseOrgPool: string[] = (() => {
  const raw = (env.SUPABASE_ORG_IDS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const list = raw.length ? raw : [env.SUPABASE_ORG_ID];
  return [...new Set(list)];
})();

/**
 * Organizations that belong to Automation Restaurant. In the "Connect your
 * Supabase" flow a restaurant owner must NOT authorize one of these — their
 * database has to live in their own org, never in ours.
 */
export const reservedOrgIds = new Set<string>([
  env.SUPABASE_ORG_ID,
  ...supabaseOrgPool,
  ...(env.SUPABASE_RESERVED_ORG_IDS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
]);
