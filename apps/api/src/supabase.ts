import { createClient } from '@supabase/supabase-js';
import { env } from './env';

/**
 * Service-role Supabase client.
 *
 * This key has BYPASSRLS. It is the ONLY sanctioned path for cross-tenant work
 * (provisioning new tenants, reconciling Stripe state). Never expose this client
 * or its key to the browser, and never use it to serve tenant-scoped reads that
 * an end user's own (RLS-bound) session could perform instead.
 */
export const supabaseAdmin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
  },
});
