-- ============================================================================
-- 0013_platform_rbac.sql  (control-plane project)
-- Granular, multi-admin permissions for the SaaS admin panel — mirrors the
-- tenant-side roles/memberships/set_member_access pattern (see
-- supabase/tenant-template/schema.sql) at the platform level. Admin identities
-- still live only in Supabase Auth (auth.users) on this project; platform_admins
-- is the mapping row that carries role/extra permissions and invite state.
-- ============================================================================

create table public.platform_roles (
  id          uuid primary key default gen_random_uuid(),
  key         text not null unique,
  name        text not null,
  permissions text[] not null default '{}',
  is_system   boolean not null default false,
  created_at  timestamptz not null default now()
);

create table public.platform_admins (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid unique references auth.users(id) on delete cascade,
  email             text not null unique,
  role              text not null references public.platform_roles(key),
  extra_permissions text[] not null default '{}',
  status            text not null default 'invited' check (status in ('invited','active','disabled')),
  invited_by        uuid references auth.users(id),
  invited_at        timestamptz not null default now(),
  accepted_at       timestamptz,
  updated_at        timestamptz not null default now()
);
create trigger set_updated_at before update on public.platform_admins
  for each row execute function app.set_updated_at();

create table public.platform_permission_catalog (
  key   text primary key,
  grp   text not null,
  label text not null
);

insert into public.platform_roles (key, name, permissions, is_system) values
  ('super_admin', 'Super Admin', array['*'], true),
  ('billing_admin', 'Billing Admin', array[
     'dashboard.view','customers.view','customers.manage','restaurants.view',
     'subscriptions.view','subscriptions.manage','invoices.view','analytics.view'
   ], true),
  ('support', 'Support', array[
     'dashboard.view','customers.view','restaurants.view','subscriptions.view',
     'invoices.view','analytics.view','audit.view'
   ], true),
  ('content_editor', 'Content Editor', array['dashboard.view','cms.manage'], true),
  ('content_publisher', 'Content Publisher', array['dashboard.view','cms.manage','cms.publish'], true)
on conflict (key) do nothing;

insert into public.platform_permission_catalog (key, grp, label) values
  ('dashboard.view', 'Overview', 'View SaaS Dashboard'),
  ('customers.view', 'Customers', 'View Customers'),
  ('customers.manage', 'Customers', 'Manage Customers'),
  ('restaurants.view', 'Restaurants', 'View Restaurants'),
  ('restaurants.manage', 'Restaurants', 'Manage Restaurants'),
  ('plans.manage', 'Subscriptions', 'Manage Plans'),
  ('subscriptions.view', 'Subscriptions', 'View Subscriptions'),
  ('subscriptions.manage', 'Subscriptions', 'Manage Subscriptions'),
  ('invoices.view', 'Subscriptions', 'View Invoices / Payments'),
  ('analytics.view', 'Analytics', 'View SaaS Analytics'),
  ('cms.manage', 'CMS', 'Manage CMS'),
  ('cms.publish', 'CMS', 'Publish CMS'),
  ('settings.manage', 'Settings', 'Manage Platform Settings'),
  ('audit.view', 'Settings', 'View Audit Logs'),
  ('users.manage', 'Settings', 'Manage Platform Users'),
  ('ai.use', 'Overview', 'Use AI Assistant')
on conflict (key) do nothing;

-- ── JWT/permission helpers (control-plane's `app` schema so far only has
--    is_super_admin()/set_updated_at() — these mirror the tenant app.jwt_*/
--    app.has_perm() helpers exactly, scoped to this project's own claims). ──

create or replace function app.platform_jwt_permissions()
returns text[] language sql stable as $$
  select coalesce(
    array(
      select jsonb_array_elements_text(
        nullif(current_setting('request.jwt.claims', true), '')::jsonb #> '{app_metadata,permissions}'
      )
    ),
    '{}'::text[]
  )
$$;

create or replace function app.jwt_role()
returns text language sql stable as $$
  select nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role'
$$;

create or replace function app.jwt_sub()
returns uuid language sql stable as $$
  select nullif(nullif(current_setting('request.jwt.claims', true), '')::jsonb #>> '{sub}', '')::uuid
$$;

create or replace function app.has_platform_perm(p_perm text)
returns boolean language sql stable as $$
  select
    app.is_super_admin()
    or app.jwt_role() = 'service_role'
    or '*' = any(app.platform_jwt_permissions())
    or p_perm = any(app.platform_jwt_permissions())
$$;

create or replace function app.compose_platform_permissions(p_role text, p_extra text[])
returns text[] language sql stable as $$
  select case
    when (select permissions from public.platform_roles where key = p_role) @> array['*'] then array['*']
    else (
      select coalesce(array_agg(distinct k order by k), '{}'::text[])
      from unnest(
        coalesce((select permissions from public.platform_roles where key = p_role), '{}'::text[])
        || coalesce(p_extra, '{}'::text[])
      ) as k
    )
  end
$$;

-- security definer: mirrors public.set_member_access's shape exactly,
-- including the anti-escalation guard (a caller can only grant a
-- permission it itself holds; service_role/'*' bypass since the Express
-- route already ran the same check against the caller's verified JWT).
create or replace function public.set_admin_access(
  p_admin_id uuid, p_role text, p_extra text[] default '{}'
) returns text[]
language plpgsql security definer set search_path = public, app as $$
declare
  v_effective text[];
  v_key text;
  v_actor text[] := app.platform_jwt_permissions();
  v_all boolean := ('*' = any(v_actor)) or app.jwt_role() = 'service_role' or app.is_super_admin();
begin
  if not app.has_platform_perm('users.manage') then
    raise exception 'forbidden' using errcode = 'insufficient_privilege';
  end if;
  if not exists (select 1 from public.platform_roles where key = p_role) then
    raise exception 'unknown_role: %', p_role using errcode = 'foreign_key_violation';
  end if;

  v_effective := app.compose_platform_permissions(p_role, p_extra);

  if not v_all then
    foreach v_key in array v_effective loop
      if not (v_key = any(v_actor)) then
        raise exception 'cannot grant a permission you do not hold: %', v_key
          using errcode = 'insufficient_privilege';
      end if;
    end loop;
  end if;

  update public.platform_admins
    set role = p_role, extra_permissions = coalesce(p_extra, '{}'::text[]), updated_at = now()
    where id = p_admin_id;

  return v_effective;
end;
$$;
revoke all on function public.set_admin_access(uuid, text, text[]) from public, authenticated, anon;
grant execute on function public.set_admin_access(uuid, text, text[]) to service_role;

alter table public.platform_roles enable row level security;
alter table public.platform_admins enable row level security;
alter table public.platform_permission_catalog enable row level security;

create policy super_admin_all on public.platform_roles for all
  using (app.is_super_admin()) with check (app.is_super_admin());
create policy platform_read on public.platform_roles for select
  using (app.has_platform_perm('users.manage') or app.has_platform_perm('dashboard.view'));

create policy super_admin_all on public.platform_admins for all
  using (app.is_super_admin()) with check (app.is_super_admin());
create policy platform_read on public.platform_admins for select
  using (app.has_platform_perm('users.manage') or app.has_platform_perm('dashboard.view'));

create policy super_admin_all on public.platform_permission_catalog for all
  using (app.is_super_admin()) with check (app.is_super_admin());
create policy platform_read on public.platform_permission_catalog for select
  using (app.has_platform_perm('dashboard.view'));
