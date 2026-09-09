-- ============================================================================
-- 0002_super_admin.sql  (control-plane project)
-- The HMS platform owner. Reads/updates every restaurant from the registry.
-- ============================================================================

create or replace function app.is_super_admin()
returns boolean
language sql
stable
as $$
  select coalesce(
    nullif(current_setting('request.jwt.claims', true), '')::jsonb #>> '{app_metadata,role}',
    ''
  ) = 'super_admin'
$$;

create policy super_admin_all on public.tenants
  for all using (app.is_super_admin()) with check (app.is_super_admin());

create policy super_admin_read on public.tenant_projects
  for select using (app.is_super_admin());

create policy super_admin_read on public.subscriptions
  for select using (app.is_super_admin());

create policy super_admin_read on public.onboarding_tokens
  for select using (app.is_super_admin());
