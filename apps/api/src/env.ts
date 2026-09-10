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

  // Supabase Management API — platform personal access token. Used for the
  // legacy "all tenants in our org" path and for control-plane migrations.
  SUPABASE_ACCESS_TOKEN: z.string().min(1, 'Management API personal access token'),
  SUPABASE_ORG_ID: z.string().min(1, 'Supabase organization id (billing enabled)'),
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

  STRIPE_SECRET_KEY: z.string().min(1),
  STRIPE_WEBHOOK_SECRET: z.string().min(1),
  STRIPE_PRICE_MAP: z.string().default(''),

  ONBOARDING_TOKEN_TTL_MINUTES: z.coerce.number().int().positive().default(30),
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
