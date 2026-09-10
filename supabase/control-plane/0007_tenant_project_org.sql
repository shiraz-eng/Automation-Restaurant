-- ============================================================================
-- Control-plane 0007 — record which Supabase organization hosts each tenant
--
-- With the free-tier org pool (SUPABASE_ORG_IDS), a tenant's dedicated project
-- can land in any pooled org. Knowing which one is platform metadata the
-- control plane is allowed to hold ("may know where a restaurant's database
-- exists") and is needed for support and teardown.
-- ============================================================================

alter table public.tenant_projects
  add column if not exists organization_id text;
