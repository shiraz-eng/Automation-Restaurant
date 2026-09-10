-- ============================================================================
-- Control-plane 0004 — admin credentials become optional
--
-- Tenants provisioned through "Connect your Supabase" no longer persist the
-- project's service_role key or database password. Routine app traffic runs as
-- anon / staff-JWT with RLS; the rare admin operation re-derives a short-lived
-- service_role key from the stored OAuth refresh token (see
-- apps/api/src/lib/tenantAdmin.ts).
--
-- Legacy platform-org tenants keep their stored key (no OAuth grant to fall
-- back on), so the columns stay — just nullable.
-- ============================================================================

alter table public.tenant_projects alter column service_key  drop not null;
alter table public.tenant_projects alter column db_password  drop not null;

comment on column public.tenant_projects.service_key is
  'Legacy platform-org tenants only. NULL for Connect-flow tenants — the key is '
  'minted on demand from supabase_connections.refresh_token.';
