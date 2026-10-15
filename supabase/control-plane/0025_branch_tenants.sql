-- ============================================================================
-- 0025 — Independent branches.
--
-- A branch is a restaurant of its own: a tenant with its own Supabase project,
-- provisioned by the same provisionTenant() as any restaurant, in the owner's
-- own Supabase org (it borrows the main restaurant's OAuth connection). The
-- main restaurant is the owner's central panel; a branch row points at it.
--
--   tenants.parent_tenant_id   the main restaurant (null = a restaurant of its own)
--   tenants.branch_code        short code, unique per main restaurant (DHA, CLF…)
--   tenants.branch_seed_status the one-time copy of the main restaurant's menu,
--                              recipes, ingredients, suppliers, branding, tax and
--                              currency into the new branch: pending | done | failed
-- ============================================================================

alter table public.tenants add column if not exists parent_tenant_id uuid references public.tenants(id) on delete restrict;
alter table public.tenants add column if not exists branch_code text;
alter table public.tenants add column if not exists branch_seed_status text;
alter table public.tenants add column if not exists branch_seed_error text;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'tenants_branch_code_check') then
    alter table public.tenants add constraint tenants_branch_code_check
      check (branch_code is null or branch_code ~ '^[A-Z0-9][A-Z0-9-]{1,11}$');
  end if;
  if not exists (select 1 from pg_constraint where conname = 'tenants_branch_seed_status_check') then
    alter table public.tenants add constraint tenants_branch_seed_status_check
      check (branch_seed_status is null or branch_seed_status in ('pending', 'done', 'failed'));
  end if;
  -- A branch always has a code, and a main restaurant never a parent of its own branch.
  if not exists (select 1 from pg_constraint where conname = 'tenants_branch_shape_check') then
    alter table public.tenants add constraint tenants_branch_shape_check
      check ((parent_tenant_id is null) = (branch_code is null) and parent_tenant_id is distinct from id);
  end if;
end $$;

-- One code per main restaurant: a repeated "create DHA" finds the existing branch instead of a second project.
create unique index if not exists tenants_branch_code_per_parent on public.tenants (parent_tenant_id, branch_code)
  where parent_tenant_id is not null;
create index if not exists tenants_parent_idx on public.tenants (parent_tenant_id) where parent_tenant_id is not null;

-- The directory the web app reads (anon): the main restaurant's slug lets a branch
-- workspace link back to the owner's panel. Columns are appended, so existing readers keep working.
create or replace view public.tenant_directory
with (security_invoker = off) as
  select
    t.slug,
    t.restaurant_name,
    t.status,
    tp.project_ref,
    tp.project_url,
    tp.anon_key,
    s.tier,
    s.status           as subscription_status,
    s.billing_interval,
    p.slug             as parent_slug,
    t.branch_code
  from public.tenants t
  join public.tenant_projects tp on tp.tenant_id = t.id
  left join public.subscriptions s on s.tenant_id = t.id
  left join public.tenants p on p.id = t.parent_tenant_id
  where t.status = 'active';

grant select on public.tenant_directory to anon, authenticated;
