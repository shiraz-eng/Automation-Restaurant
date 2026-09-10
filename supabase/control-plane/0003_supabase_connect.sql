-- ============================================================================
-- Control-plane 0003 — "Connect your Supabase" OAuth flow
--
-- Model B provisioning: the restaurant owner authorises our OAuth app against
-- THEIR own Supabase organization; we then create the tenant project inside
-- that org using their token. These tables hold the per-tenant OAuth grant and
-- the short-lived CSRF state for the redirect handshake.
--
-- RLS is enabled with NO policies: only the service_role key (used by the API)
-- can read or write. Tokens are stored plaintext for the MVP, same as
-- tenant_projects.service_key.
-- ============================================================================

create table if not exists public.supabase_connections (
  tenant_id         uuid primary key references public.tenants(id) on delete cascade,
  organization_id   text not null,
  organization_slug text,
  organization_name text,
  access_token      text not null,
  refresh_token     text not null,
  token_expires_at  timestamptz not null,
  scope             text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
alter table public.supabase_connections enable row level security;

-- Single-use CSRF state for the authorize -> callback round trip.
create table if not exists public.oauth_states (
  state_hash  text primary key,
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null,
  consumed_at timestamptz
);
alter table public.oauth_states enable row level security;
create index if not exists oauth_states_tenant_idx on public.oauth_states(tenant_id);

-- tenants.status gains 'awaiting_connection' (column is free text, no constraint
-- change needed) — a tenant sits here after checkout until the owner connects
-- their Supabase account, at which point it moves to 'provisioning'.
