import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { supabaseAdmin } from '../supabase';
import { mgmtClient } from '../mgmt';
import { getFreshConnection } from './supabaseOAuth';

/**
 * An ephemeral service-role client for one tenant's project.
 *
 * We deliberately do NOT persist the service_role key or db password for
 * tenants provisioned through "Connect your Supabase". Routine app traffic runs
 * as anon / staff-JWT with RLS. The few operations that genuinely need admin
 * rights (creating the owner account, staff invites, schema migrations)
 * re-derive a service_role key on demand from the stored OAuth refresh token,
 * use it, and drop it.
 *
 * Legacy tenants (provisioned into the platform org) still have a stored
 * service_key; those are used directly.
 */
export async function tenantServiceClient(
  tenantId: string,
): Promise<{ admin: SupabaseClient; projectUrl: string } | null> {
  const { data: proj } = await supabaseAdmin
    .from('tenant_projects')
    .select('project_ref, project_url, service_key')
    .eq('tenant_id', tenantId)
    .maybeSingle();
  if (!proj) return null;

  // Legacy: key was stored at provisioning time.
  if (proj.service_key) {
    return {
      admin: createClient(proj.project_url, proj.service_key, {
        auth: { persistSession: false, autoRefreshToken: false },
      }),
      projectUrl: proj.project_url,
    };
  }

  // Connect flow: mint a short-lived key from the owner's OAuth grant.
  const conn = await getFreshConnection(tenantId);
  const keys = await mgmtClient(conn.access_token).getApiKeys(proj.project_ref);
  return {
    admin: createClient(proj.project_url, keys.service_role, {
      auth: { persistSession: false, autoRefreshToken: false },
    }),
    projectUrl: proj.project_url,
  };
}

/** Same, resolved by slug. */
export async function tenantServiceClientBySlug(
  slug: string,
): Promise<{ admin: SupabaseClient; projectUrl: string } | null> {
  const { data: t } = await supabaseAdmin
    .from('tenants')
    .select('id')
    .eq('slug', slug)
    .maybeSingle();
  if (!t) return null;
  return tenantServiceClient(t.id);
}
