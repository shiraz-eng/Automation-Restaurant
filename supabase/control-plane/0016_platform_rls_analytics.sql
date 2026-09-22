-- ============================================================================
-- 0016_platform_rls_analytics.sql  (control-plane project)
-- Analytics/Overview read both subscriptions and plans directly via RLS —
-- extend the read policies from 0015 to also admit analytics.view/
-- dashboard.view, not just subscriptions.view/plans.manage.
-- ============================================================================

drop policy if exists platform_read on public.subscriptions;
create policy platform_read on public.subscriptions for select
  using (
    app.has_platform_perm('subscriptions.view')
    or app.has_platform_perm('analytics.view')
    or app.has_platform_perm('dashboard.view')
  );

drop policy if exists platform_read on public.plans;
create policy platform_read on public.plans for select
  using (
    app.has_platform_perm('plans.manage')
    or app.has_platform_perm('subscriptions.view')
    or app.has_platform_perm('analytics.view')
    or app.has_platform_perm('dashboard.view')
  );

drop policy if exists platform_read on public.tenants;
create policy platform_read on public.tenants for select
  using (
    app.has_platform_perm('restaurants.view')
    or app.has_platform_perm('customers.view')
    or app.has_platform_perm('dashboard.view')
  );

create policy platform_read on public.contact_messages for select
  using (app.has_platform_perm('settings.manage'));
