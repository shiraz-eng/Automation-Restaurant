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
type TenantClient = { admin: SupabaseClient; projectUrl: string };

// Warm-instance cache: every API request used to re-read the control plane
// (and, for connected tenants, refresh the owner's OAuth token and re-fetch
// the project's API keys). A short cache takes that off the hot path.
const CLIENT_TTL_MS = 10 * 60_000;
const clientCache = new Map<string, { client: TenantClient; at: number }>();
const slugCache = new Map<string, { tenantId: string; at: number }>();

/** A control-plane read, retried — it intermittently times out (522), and a
 *  transient failure must never look like "this restaurant doesn't exist". */
async function controlPlaneRead<T>(read: () => PromiseLike<{ data: T | null; error: { message: string } | null }>): Promise<T | null> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const { data, error } = await read();
    if (!error) return data;
    lastErr = error;
    await new Promise((r) => setTimeout(r, 400 * attempt));
  }
  throw new Error(`control plane unavailable: ${(lastErr as { message?: string })?.message ?? lastErr}`);
}

export async function tenantServiceClient(tenantId: string): Promise<TenantClient | null> {
  const cached = clientCache.get(tenantId);
  if (cached && Date.now() - cached.at < CLIENT_TTL_MS) return cached.client;

  const proj = await controlPlaneRead<{ project_ref: string; project_url: string; service_key: string | null }>(() =>
    supabaseAdmin
      .from('tenant_projects')
      .select('project_ref, project_url, service_key')
      .eq('tenant_id', tenantId)
      .maybeSingle(),
  );
  if (!proj) return null;

  let serviceKey = proj.service_key as string | null;
  if (!serviceKey) {
    // Connect flow: mint the key from the owner's OAuth grant, then keep
    // it (as provisioning already does for platform-org tenants). Minting
    // on every request made every API feature depend on a single-use OAuth
    // refresh token — one failed save of a rotated token broke the
    // restaurant for good ("No such refresh token found").
    const conn = await getFreshConnection(tenantId);
    const keys = await mgmtClient(conn.access_token).getApiKeys(proj.project_ref);
    serviceKey = keys.service_role;
    await supabaseAdmin.from('tenant_projects').update({ service_key: serviceKey }).eq('tenant_id', tenantId);
  }
  const client = {
    admin: createClient(proj.project_url, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    }),
    projectUrl: proj.project_url,
  };
  clientCache.set(tenantId, { client, at: Date.now() });
  return client;
}

/** Resolves a restaurant's admin client, telling "no such restaurant" apart
 *  from "couldn't reach it right now" (control plane down, OAuth failure). */
export async function resolveTenantClient(
  slug: string,
): Promise<{ ok: true; client: TenantClient; tenantId: string } | { ok: false; reason: 'not_found' | 'unavailable'; detail?: string }> {
  try {
    let tenantId = slugCache.get(slug);
    if (!tenantId || Date.now() - tenantId.at > CLIENT_TTL_MS) {
      const t = await controlPlaneRead<{ id: string }>(() => supabaseAdmin.from('tenants').select('id').eq('slug', slug).maybeSingle());
      if (!t) return { ok: false, reason: 'not_found' };
      tenantId = { tenantId: (t as { id: string }).id, at: Date.now() };
      slugCache.set(slug, tenantId);
    }
    const client = await tenantServiceClient(tenantId.tenantId);
    if (!client) return { ok: false, reason: 'not_found', detail: 'restaurant has no database yet (setup not finished)' };
    return { ok: true, client, tenantId: tenantId.tenantId };
  } catch (err) {
    console.error(`[tenant] resolving ${slug} failed:`, err);
    return { ok: false, reason: 'unavailable', detail: String((err as Error).message ?? err) };
  }
}

/** Same, resolved by slug. Returns null when the restaurant can't be
 *  resolved for any reason (callers treat that as not found). */
export async function tenantServiceClientBySlug(slug: string): Promise<TenantClient | null> {
  const r = await resolveTenantClient(slug);
  return r.ok ? r.client : null;
}
