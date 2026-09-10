import { randomBytes, createHash } from 'node:crypto';
import { env } from '../env';
import { supabaseAdmin } from '../supabase';
import { mgmtClient, type Organization } from '../mgmt';

/**
 * "Connect your Supabase" — OAuth2 authorization-code flow against the Supabase
 * Management API. The restaurant owner authorises our app against their own
 * Supabase organization; we exchange the code for an access/refresh token pair
 * and provision their tenant project inside that org.
 *
 * Docs: https://supabase.com/docs/guides/integrations/build-a-supabase-integration
 */
const AUTHORIZE_URL = 'https://api.supabase.com/v1/oauth/authorize';
const TOKEN_URL = 'https://api.supabase.com/v1/oauth/token';

/** Seconds before expiry at which we proactively refresh. */
const REFRESH_SKEW_SECONDS = 120;
const STATE_TTL_MS = 15 * 60_000;

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  token_type: string;
  expires_in: number;
  scope?: string;
}

export interface SupabaseConnection {
  tenant_id: string;
  organization_id: string;
  organization_slug: string | null;
  organization_name: string | null;
  access_token: string;
  refresh_token: string;
  token_expires_at: string;
  scope: string | null;
}

function sha256(v: string): string {
  return createHash('sha256').update(v).digest('hex');
}

function basicAuthHeader(): string {
  const raw = `${env.SUPABASE_OAUTH_CLIENT_ID}:${env.SUPABASE_OAUTH_CLIENT_SECRET}`;
  return `Basic ${Buffer.from(raw).toString('base64')}`;
}

/** Build the URL to send the owner to. `state` is the raw (unhashed) value. */
export function buildAuthorizeUrl(state: string): string {
  const u = new URL(AUTHORIZE_URL);
  u.searchParams.set('client_id', env.SUPABASE_OAUTH_CLIENT_ID ?? '');
  u.searchParams.set('redirect_uri', env.SUPABASE_OAUTH_REDIRECT_URI);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('state', state);
  return u.toString();
}

/** Create a single-use CSRF state bound to a tenant. Returns the raw value. */
export async function createOAuthState(tenantId: string): Promise<string> {
  const raw = randomBytes(32).toString('base64url');
  const { error } = await supabaseAdmin.from('oauth_states').insert({
    state_hash: sha256(raw),
    tenant_id: tenantId,
    expires_at: new Date(Date.now() + STATE_TTL_MS).toISOString(),
  });
  if (error) throw new Error(`oauth state insert failed: ${error.message}`);
  return raw;
}

/** Validate + consume a state. Returns the bound tenant id, or null. */
export async function consumeOAuthState(raw: string): Promise<string | null> {
  const now = new Date().toISOString();
  const { data, error } = await supabaseAdmin
    .from('oauth_states')
    .update({ consumed_at: now })
    .eq('state_hash', sha256(raw))
    .is('consumed_at', null)
    .gt('expires_at', now)
    .select('tenant_id')
    .maybeSingle();
  if (error) {
    console.error('[oauth] state consume failed:', error.message);
    return null;
  }
  return data?.tenant_id ?? null;
}

async function postToken(body: Record<string, string>): Promise<TokenResponse> {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      Authorization: basicAuthHeader(),
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: new URLSearchParams(body).toString(),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Supabase OAuth token ${res.status}: ${text}`);
  return JSON.parse(text) as TokenResponse;
}

function expiryISO(expiresIn: number): string {
  return new Date(Date.now() + expiresIn * 1000).toISOString();
}

/**
 * Exchange an authorization code for tokens, resolve the granted organization,
 * and persist the connection for `tenantId`.
 */
export async function exchangeAndStore(
  tenantId: string,
  code: string,
): Promise<SupabaseConnection> {
  const tok = await postToken({
    grant_type: 'authorization_code',
    code,
    redirect_uri: env.SUPABASE_OAUTH_REDIRECT_URI,
  });

  // The token is scoped to the org the owner picked during authorization.
  let org: Organization | undefined;
  try {
    const orgs = await mgmtClient(tok.access_token).listOrganizations();
    org = orgs[0];
  } catch (e) {
    console.error('[oauth] listOrganizations failed:', e);
  }
  if (!org) throw new Error('could not resolve the authorized Supabase organization');

  const row = {
    tenant_id: tenantId,
    organization_id: org.id,
    organization_slug: org.slug ?? null,
    organization_name: org.name ?? null,
    access_token: tok.access_token,
    refresh_token: tok.refresh_token,
    token_expires_at: expiryISO(tok.expires_in),
    scope: tok.scope ?? null,
    updated_at: new Date().toISOString(),
  };
  const { error } = await supabaseAdmin
    .from('supabase_connections')
    .upsert(row, { onConflict: 'tenant_id' });
  if (error) throw new Error(`connection upsert failed: ${error.message}`);
  return row as SupabaseConnection;
}

/**
 * Return a connection for `tenantId` with a non-expired access token, rotating
 * the refresh token and persisting if a refresh was needed.
 */
export async function getFreshConnection(tenantId: string): Promise<SupabaseConnection> {
  const { data, error } = await supabaseAdmin
    .from('supabase_connections')
    .select('*')
    .eq('tenant_id', tenantId)
    .maybeSingle();
  if (error || !data) {
    throw new Error(error?.message ?? `no Supabase connection for tenant ${tenantId}`);
  }
  const conn = data as SupabaseConnection;

  const msLeft = new Date(conn.token_expires_at).getTime() - Date.now();
  if (msLeft > REFRESH_SKEW_SECONDS * 1000) return conn;

  const tok = await postToken({
    grant_type: 'refresh_token',
    refresh_token: conn.refresh_token,
  });
  const patch = {
    access_token: tok.access_token,
    refresh_token: tok.refresh_token, // Supabase rotates refresh tokens
    token_expires_at: expiryISO(tok.expires_in),
    scope: tok.scope ?? conn.scope,
    updated_at: new Date().toISOString(),
  };
  const { error: upErr } = await supabaseAdmin
    .from('supabase_connections')
    .update(patch)
    .eq('tenant_id', tenantId);
  if (upErr) throw new Error(`token refresh persist failed: ${upErr.message}`);
  return { ...conn, ...patch };
}
