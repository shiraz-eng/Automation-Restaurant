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

  // Supabase Management API — used to create a dedicated project per restaurant.
  SUPABASE_ACCESS_TOKEN: z.string().min(1, 'Management API personal access token'),
  SUPABASE_ORG_ID: z.string().min(1, 'Supabase organization id (billing enabled)'),
  SUPABASE_REGION: z.string().min(1).default('us-east-1'),
  SUPABASE_PROJECT_PLAN: z.enum(['free', 'pro']).default('free'),

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
