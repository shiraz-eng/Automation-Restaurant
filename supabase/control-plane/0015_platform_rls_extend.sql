-- ============================================================================
-- 0015_platform_rls_extend.sql  (control-plane project)
-- Phase 1 follow-up: every admin page reads tenants/subscriptions/plans/
-- tenant_projects/onboarding_tokens directly via RLS (no Express layer in
-- between for reads). Those tables' existing policies only ever checked
-- app.is_super_admin() (literal role='super_admin'), so a granular platform
-- admin (e.g. a 'support' role with only view permissions) would get zero
-- rows back even after passing gateAdminPage(). This adds read policies
-- keyed to the specific permission each table actually needs.
-- ============================================================================

create policy platform_read on public.tenants for select
  using (app.has_platform_perm('restaurants.view') or app.has_platform_perm('customers.view'));

create policy platform_read on public.tenant_projects for select
  using (app.has_platform_perm('restaurants.view'));

create policy platform_read on public.subscriptions for select
  using (app.has_platform_perm('subscriptions.view'));

create policy platform_read on public.onboarding_tokens for select
  using (app.has_platform_perm('restaurants.view'));

create policy platform_read on public.plans for select
  using (app.has_platform_perm('plans.manage') or app.has_platform_perm('subscriptions.view'));
create policy platform_write on public.plans for all
  using (app.has_platform_perm('plans.manage')) with check (app.has_platform_perm('plans.manage'));

create policy platform_read on public.site_sections for select
  using (app.has_platform_perm('cms.manage'));
