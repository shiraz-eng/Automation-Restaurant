-- ============================================================================
-- TENANT TEMPLATE schema — executed once into every newly provisioned
-- Supabase project. Each project belongs to exactly ONE restaurant, so there
-- are no tenant_id columns and no tenant-scoped RLS: isolation is the project
-- boundary. RLS here only enforces staff roles within the restaurant.
--
-- Applied by apps/api via the Management API query endpoint.
-- ============================================================================

create extension if not exists pgcrypto;
create schema if not exists app;
grant usage on schema app to anon, authenticated, service_role;

create or replace function app.current_member_role()
returns text language sql stable as $$
  select nullif(current_setting('request.jwt.claims', true), '')::jsonb #>> '{app_metadata,role}'
$$;

create or replace function app.is_staff()
returns boolean language sql stable as $$
  select app.current_member_role() is not null
$$;

create or replace function app.can_write()
returns boolean language sql stable as $$
  select app.current_member_role() in ('owner', 'manager')
$$;

-- ── Permission system (Phase 1) ───────────────────────────────────────────
-- Every portal / staff JWT carries app_metadata.permissions: a text[] of keys
-- like 'orders.view', 'payments.accept', 'stock.update'. '*' means all.
-- Authorization decisions use app.has_perm(), never a portal/role name.
-- is_staff()/can_write() are kept for backward compatibility during migration.

create or replace function app.jwt_permissions()
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

-- The top-level 'role' claim (service_role/authenticated/anon) — NOT
-- app_metadata.role (that's app.current_member_role()). This PostgREST
-- setup never populates the per-claim 'request.jwt.claim.role' GUC that
-- has_perm() used to read here (it was always '' <> 'service_role', so
-- that clause never once fired — harmless for RLS itself, since the
-- service_role Postgres role bypasses row security independently of
-- has_perm(), but it silently broke every EXPLICIT has_perm()/service_role
-- check inside a SECURITY DEFINER function body, e.g. set_member_access's
-- and set_portal_staff's (0044) "v_all" anti-escalation short-circuit).
-- The aggregate 'request.jwt.claims' GUC IS populated and carries role at
-- its top level, so read it from there instead (0044).
create or replace function app.jwt_role()
returns text language sql stable as $$
  select nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role'
$$;

create or replace function app.has_perm(p_perm text)
returns boolean language sql stable as $$
  select
    -- service_role bypasses RLS entirely; this covers authenticated portals.
    app.jwt_role() = 'service_role'
    or '*' = any(app.jwt_permissions())
    or p_perm = any(app.jwt_permissions())
    -- transitional: an owner/manager with no explicit permissions still writes.
    or (app.jwt_permissions() = '{}'::text[] and app.can_write())
$$;

-- Current user's auth id (for actor columns in SECURITY DEFINER RPCs).
create or replace function app.jwt_sub() returns uuid language sql stable as $$
  select nullif(nullif(current_setting('request.jwt.claims', true), '')::jsonb #>> '{sub}', '')::uuid
$$;

-- RPC-level audit writer (the app.audit_row trigger only covers table DML).
create or replace function app.log_action(
  p_action text, p_entity text, p_entity_id text,
  p_before jsonb default null, p_after jsonb default null
) returns void language plpgsql security definer set search_path = public, app as $fn$
declare v_claims jsonb := nullif(current_setting('request.jwt.claims', true), '')::jsonb;
begin
  insert into public.audit_logs
    (actor_id, actor_email, actor_role, action, entity, entity_id, before, after)
  values
    (app.jwt_sub(), v_claims #>> '{email}', app.current_member_role(),
     p_action, p_entity, p_entity_id, p_before, p_after);
end $fn$;

-- Reference catalogue of permission keys (documentation + future admin UI).
-- Not enforced by FK — JWT arrays are free-form — but the app validates against it.
-- In public so the portal UI can read it through PostgREST.
-- type: read/write/approval/export — what kind of action this permission
-- grants, independent of which application area it's in. risk_level:
-- normal/high — high marks anything destructive, financially sensitive,
-- or authorization-escalating (delete/void/reopen/credentials/role and
-- permission management, etc). Both drive Portal Management's selected-
-- permission summary and risk badges — never hardcoded client-side.
create table if not exists public.permission_catalog (
  key        text primary key,
  grp        text not null,
  label      text not null,
  type       text not null default 'write' check (type in ('read', 'write', 'approval', 'export')),
  risk_level text not null default 'normal' check (risk_level in ('normal', 'high'))
);
insert into public.permission_catalog (key, grp, label, type, risk_level) values
  ('orders.view','Orders','View orders','read','normal'),
  ('orders.create','Orders','Create orders','write','normal'),
  ('orders.update','Orders','Update orders','write','normal'),
  ('orders.cancel','Orders','Cancel orders','write','normal'),
  ('payments.view','Payments','View payments','read','normal'),
  ('payments.accept','Payments','Accept payment','write','normal'),
  ('payments.refund','Payments','Refund payment','write','normal'),
  ('payments.approve_refund','Payments','Approve a refund above the configured threshold','approval','high'),
  ('kitchen.view','Kitchen','View kitchen queue','read','normal'),
  ('kitchen.update_status','Kitchen','Update order/prep status','write','normal'),
  ('menu.view','Menu','View menu','read','normal'),
  ('menu.create','Menu','Create menu items','write','normal'),
  ('menu.update','Menu','Update menu items','write','normal'),
  ('menu.delete','Menu','Delete menu items','write','high'),
  ('stock.view','Stock','View food availability','read','normal'),
  ('stock.update','Stock','Update food availability','write','normal'),
  ('attendance.view','Attendance','View attendance','read','normal'),
  ('attendance.mark','Attendance','Mark attendance','write','normal'),
  ('staff.view','Staff','View staff','read','normal'),
  ('staff.create','Staff','Create staff','write','normal'),
  ('staff.update','Staff','Update staff','write','normal'),
  ('staff.delete','Staff','Delete staff','write','high'),
  ('reviews.view','Reviews','View customer reviews','read','normal'),
  ('reviews.analytics','Reviews','View review analytics','read','normal'),
  ('reviews.respond','Reviews','Respond to reviews','write','normal'),
  ('reviews.moderate','Reviews','Moderate reviews','write','normal'),
  ('reports.view','Reports','View reports','read','normal'),
  ('settings.view','Settings','View settings','read','normal'),
  ('settings.update','Settings','Update settings','write','high'),
  ('portals.view','Portal Management','View portals','read','high'),
  ('portals.create','Portal Management','Create portals','write','high'),
  ('portals.update','Portal Management','Update portals','write','high'),
  ('portals.disable','Portal Management','Enable/disable portals','write','high'),
  ('portals.credentials','Portal Management','Manage portal credentials','approval','high')
on conflict (key) do update set grp = excluded.grp, label = excluded.label, type = excluded.type, risk_level = excluded.risk_level;

-- Operations / Attendance / AI key set (P3). Kept in one place so the Portal
-- Management UI can offer every grantable permission.
insert into public.permission_catalog (key, grp, label, type, risk_level) values
  ('orders.reopen','Orders','Reopen orders','write','normal'),
  ('orders.apply_discount','Orders','Apply discount','write','normal'),
  ('orders.override_price','Orders','Override item price','write','high'),
  ('payments.void','Payments','Void payment','write','high'),
  ('payments.adjust','Payments','Adjust payment','write','high'),
  ('payments.reconcile','Payments','Reconcile payments','write','normal'),
  ('receipts.view','Payments','View receipts','read','normal'),
  ('receipts.print','Payments','Print receipts','export','normal'),
  ('variants.view','Menu','View variants','read','normal'),
  ('variants.create','Menu','Create variants','write','normal'),
  ('variants.update','Menu','Update variants','write','normal'),
  ('variants.archive','Menu','Archive variants','write','normal'),
  ('deals.view','Deals','View deals','read','normal'),
  ('deals.create','Deals','Create deals','write','normal'),
  ('deals.update','Deals','Update deals','write','normal'),
  ('deals.archive','Deals','Archive deals','write','normal'),
  ('customers.view','Customers','View customers','read','normal'),
  ('customers.create','Customers','Create customers','write','normal'),
  ('customers.update','Customers','Update customers','write','normal'),
  ('tables.view','Tables','View tables','read','normal'),
  ('tables.create','Tables','Create tables','write','normal'),
  ('tables.update','Tables','Update tables','write','normal'),
  ('availability.view','Availability','View food availability','read','normal'),
  ('availability.update','Availability','Update food availability','write','normal'),
  ('roles.view','Roles','View roles','read','high'),
  ('roles.create','Roles','Create roles','write','high'),
  ('roles.update','Roles','Update roles','write','high'),
  ('roles.delete','Roles','Delete roles','write','high'),
  ('permissions.view','Permissions','View permission assignments','read','high'),
  ('permissions.assign','Permissions','Assign permissions','approval','high'),
  ('purchases.view','Purchases','View purchases','read','normal'),
  ('purchases.create','Purchases','Create purchases','write','normal'),
  ('purchases.update','Purchases','Update purchases','write','normal'),
  ('purchases.delete','Purchases','Delete purchases','write','high'),
  ('supplier.view','Suppliers','View suppliers','read','normal'),
  ('supplier.create','Suppliers','Create suppliers','write','normal'),
  ('supplier.update','Suppliers','Update suppliers','write','normal'),
  ('supplier.manage','Suppliers','Manage suppliers','write','normal'),
  ('stock.adjust','Stock','Adjust stock','write','normal'),
  ('stock.history','Stock','View stock history','read','normal'),
  ('stock.count','Stock','Perform stock counts','write','normal'),
  ('purchases.receive','Purchases','Receive purchase deliveries','write','normal'),
  ('purchases.approve','Purchases','Approve purchase orders','approval','high'),
  ('invoices.view','Invoices','View supplier invoices','read','normal'),
  ('invoices.create','Invoices','Create/upload supplier invoices','write','normal'),
  ('invoices.match','Invoices','Run/approve invoice matching','approval','normal'),
  ('payables.view','Payables','View accounts payable','read','normal'),
  ('payables.record_payment','Payables','Record supplier payments','write','high'),
  ('payables.manage','Payables','Resolve payment holds, credit notes','write','high'),
  ('inventory.manage_waste','Inventory','Record ingredient waste','write','normal'),
  ('inventory.manage_recipes','Inventory','Manage recipes','write','normal'),
  ('inventory.view_cost','Inventory','View ingredient & recipe cost','read','normal'),
  ('inventory.manage','Inventory','Manage inventory items','write','normal'),
  ('inventory.manage_purchases','Inventory','Manage purchase automation','write','normal'),
  ('finance.view','Finance','View finance','read','normal'),
  ('finance.create_expense','Finance','Create expense','write','normal'),
  ('finance.update_expense','Finance','Update expense','write','normal'),
  ('finance.delete_expense','Finance','Delete expense','write','high'),
  ('finance.view_cogs','Finance','View COGS','read','normal'),
  ('finance.view_profit','Finance','View profit','read','normal'),
  ('finance.manage_costs','Finance','Manage product costs','write','normal'),
  ('finance.manage_recipes','Finance','Manage recipes','write','normal'),
  ('finance.manage_purchases','Finance','Manage purchase costs','write','normal'),
  ('finance.reconcile','Finance','Reconcile cash','write','normal'),
  ('finance.close_day','Finance','Close business day','write','normal'),
  ('finance.reopen_day','Finance','Reopen business day','write','high'),
  ('reports.generate','Reports','Generate reports','write','normal'),
  ('reports.export','Reports','Export reports','export','normal'),
  ('analytics.view','Analytics','View analytics','read','normal'),
  ('analytics.export','Analytics','Export analytics','export','normal'),
  ('attendance.view_dashboard','Attendance','View attendance dashboard','read','normal'),
  ('attendance.view_reports','Attendance','View attendance reports','read','normal'),
  ('attendance.view_employee_reports','Attendance','View employee attendance reports','read','normal'),
  ('attendance.view_own','Attendance','View own attendance','read','normal'),
  ('attendance.check_in','Attendance','Check in','write','normal'),
  ('attendance.check_out','Attendance','Check out','write','normal'),
  ('attendance.view_history','Attendance','View attendance history','read','normal'),
  ('attendance.request_correction','Attendance','Request attendance correction','write','normal'),
  ('attendance.correct','Attendance','Correct attendance','write','normal'),
  ('attendance.approve_correction','Attendance','Approve attendance correction','approval','normal'),
  ('attendance.export','Attendance','Export attendance','export','normal'),
  ('kitchen.manage_availability','Kitchen','Manage food availability','write','normal'),
  ('kitchen.record_waste','Kitchen','Record kitchen waste','write','normal'),
  ('notifications.view','Notifications','View notifications','read','normal'),
  ('notifications.manage','Notifications','Manage notifications','write','normal'),
  ('ai.view','AI','Use the AI assistant','read','normal'),
  ('ai.execute_read','AI','AI read actions','read','normal'),
  ('ai.execute_write','AI','AI write actions','write','high'),
  ('ai.approve_sensitive_action','AI','Approve sensitive AI actions','approval','high'),
  ('social.view','Social','View connected social accounts & posts','read','normal'),
  ('social.manage','Social','Connect/disconnect social accounts','write','normal'),
  ('social.propose_post','Social','Draft a social media post','write','normal'),
  ('social.approve_post','Social','Approve & publish a social media post','approval','normal')
on conflict (key) do update set grp = excluded.grp, label = excluded.label, type = excluded.type, risk_level = excluded.risk_level;

alter table public.permission_catalog enable row level security;
create policy staff_read on public.permission_catalog for select using (app.is_staff());

-- ── Enums ──────────────────────────────────────────────────────────────────
create type app.member_role         as enum ('owner', 'manager', 'cashier', 'chef', 'waiter', 'host', 'hr', 'accountant', 'delivery');
create type app.member_status       as enum ('pending', 'active', 'disabled');
create type app.order_channel       as enum ('dine_in', 'takeaway', 'delivery');
create type app.order_status        as enum ('pending', 'in_kitchen', 'ready', 'served', 'paid', 'void');
create type app.line_status         as enum ('queued', 'preparing', 'ready', 'served');
create type app.stock_reason        as enum ('order_deduction', 'restock', 'adjustment', 'spoilage', 'stock_take');
create type app.reservation_status  as enum ('pending', 'confirmed', 'arrived', 'seated', 'completed', 'cancelled', 'no_show');
create type app.modifier_kind       as enum ('required_single', 'optional_single', 'multi');

-- ── Staff ──────────────────────────────────────────────────────────────────
create table public.memberships (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid references auth.users(id) on delete set null,
  email             text not null unique,
  full_name         text,
  role              app.member_role not null default 'waiter',
  extra_permissions text[] not null default '{}',   -- granted on top of the role preset
  status            app.member_status not null default 'pending',
  -- Default expected clock-in time, set at staff creation/edit — used by
  -- app.recompute_attendance() to compute late_minutes when no explicit
  -- shifts row exists for that day (tenant-migrations/0053).
  shift_start_time  time,
  created_at        timestamptz not null default now()
);
create index memberships_user_id_idx on public.memberships(user_id);

-- The caller's own membership id, bypassing RLS (used in RLS self-read paths).
create or replace function app.my_membership_id() returns uuid
language sql stable security definer set search_path = public, app as $fn$
  select id from public.memberships where user_id = app.jwt_sub()
$fn$;

-- ── Roles (P3) ─────────────────────────────────────────────────────────────
-- Named permission presets. A membership's effective permission set is
-- app.compose_permissions(role, extra_permissions) — role preset ∪ extras,
-- collapsed to {'*'} for all-access. Back-filled onto each staff Auth user's
-- app_metadata.permissions (see supabase/tenant-migrations/0007_roles.sql).
create table public.roles (
  id          uuid primary key default gen_random_uuid(),
  key         text not null unique,
  name        text not null,
  permissions text[] not null default '{}',
  is_system   boolean not null default false,
  created_at  timestamptz not null default now()
);

do $$
declare base text[] := array[
  'orders.view','kitchen.view','menu.view','stock.view','tables.view',
  'reviews.view','notifications.view','attendance.view_own',
  'attendance.check_in','attendance.check_out'
];
begin
  insert into public.roles (key, name, permissions, is_system) values
    ('owner','Owner', array['*'], true),
    -- Default Manager: operational/business access, NOT ownership-level.
    -- Deliberately excludes payments.refund/approve_refund/adjust/reconcile,
    -- finance.view, and the Recipes & Food Cost cost-visibility keys
    -- (inventory.manage_recipes/inventory.view_cost) — an Owner grants
    -- these per-manager from Roles & Access Control (or per-member via
    -- Staff's extra grants) when a specific manager needs them; they are
    -- never automatic just from holding the 'manager' role. portals.view
    -- (Kiosk Portal management) is owner-only regardless of grant — left
    -- out of the default for the same reason.
    ('manager','Manager', base || array[
      'orders.create','orders.update','orders.cancel','orders.reopen',
      'orders.apply_discount','orders.override_price',
      'payments.view','payments.accept','payments.void','receipts.view','receipts.print',
      'kitchen.update_status','kitchen.manage_availability','kitchen.record_waste',
      'menu.create','menu.update','menu.archive',
      'variants.view','variants.create','variants.update','variants.archive',
      'deals.view','deals.create','deals.update','deals.archive',
      'availability.view','availability.update',
      'stock.update','stock.adjust','stock.history','stock.count',
      'inventory.manage_waste',
      'tables.create','tables.update',
      'customers.view','customers.create','customers.update',
      'supplier.view','supplier.create','supplier.update','supplier.manage',
      'purchases.view','purchases.create','purchases.update','purchases.receive','purchases.approve',
      'invoices.view','invoices.create','invoices.match','payables.view',
      'staff.view','staff.create','staff.update','staff.disable','roles.view',
      'attendance.view','attendance.mark','attendance.view_dashboard',
      'attendance.view_reports','attendance.view_employee_reports',
      'attendance.view_history','attendance.correct','attendance.approve_correction',
      'reports.view','reports.generate','reports.export',
      'analytics.view','settings.view',
      'notifications.manage','ai.view','ai.execute_read',
      'social.view','social.manage','social.propose_post','social.approve_post'
    ], true),
    ('cashier','Cashier', base || array[
      'orders.create','orders.update','orders.apply_discount',
      'payments.view','payments.accept','receipts.view','receipts.print',
      'tables.update','customers.view','customers.create'
    ], true),
    ('chef','Kitchen', base || array[
      'orders.update','kitchen.update_status','kitchen.manage_availability',
      'kitchen.record_waste','availability.view','availability.update','stock.history'
    ], true),
    ('waiter','Waiter', base || array[
      'orders.create','orders.update','customers.view','customers.create','tables.update'
    ], true),
    ('host','Host', base || array[
      'tables.create','tables.update','customers.view','customers.create','customers.update'
    ], true),
    ('hr','HR', base || array[
      'staff.view','staff.create','staff.update','staff.disable','roles.view',
      'attendance.view','attendance.mark','attendance.view_dashboard',
      'attendance.view_reports','attendance.view_employee_reports',
      'attendance.view_history','attendance.correct','attendance.approve_correction',
      'attendance.export'
    ], true),
    ('accountant','Accountant', base || array[
      'finance.view','finance.create_expense','finance.update_expense',
      'finance.delete_expense','finance.view_cogs','finance.view_profit',
      'finance.manage_costs','finance.manage_recipes','finance.manage_purchases',
      'finance.reconcile','finance.close_day','finance.reopen_day',
      'payments.view','payments.reconcile','purchases.view','purchases.approve','supplier.view',
      'invoices.view','invoices.create','invoices.match',
      'payables.view','payables.record_payment','payables.manage',
      'reports.view','reports.generate','reports.export',
      'analytics.view','analytics.export'
    ], true),
    ('delivery','Delivery', base || array['orders.update','customers.view'], true)
  on conflict (key) do update
    set name = excluded.name, permissions = excluded.permissions, is_system = true;
end $$;

create or replace function app.role_permissions(p_role text)
returns text[] language sql stable as $$
  select coalesce((select permissions from public.roles where key = p_role), '{}'::text[])
$$;

create or replace function app.compose_permissions(p_role text, p_extra text[])
returns text[] language sql stable as $$
  select case
    when app.role_permissions(p_role) @> array['*'] then array['*']
    else (
      select coalesce(array_agg(distinct k order by k), '{}'::text[])
      from unnest(app.role_permissions(p_role) || coalesce(p_extra, '{}'::text[])) as k
    )
  end
$$;

-- A membership's full effective permissions: role preset ∪ extra_permissions
-- ∪ the permissions of every portal it's linked to via portal_staff (0044).
-- '*' anywhere collapses the result to {'*'}. public.portals/portal_staff
-- are defined later in this file — fine for a plain SQL function, whose body
-- is only resolved at call time, not at CREATE FUNCTION time.
create or replace function app.membership_effective_permissions(
  p_role text, p_extra text[], p_membership_id uuid
) returns text[] language sql stable as $$
  with role_perms as (
    select app.compose_permissions(p_role, p_extra) as perms
  ),
  portal_perms as (
    select coalesce(array_agg(distinct perm), '{}'::text[]) as perms
    from public.portal_staff ps
    join public.portals p on p.id = ps.portal_id
    cross join lateral unnest(p.permissions) as perm
    where ps.membership_id = p_membership_id and p.status = 'active'
  )
  select case
    when (select perms from role_perms) @> array['*'] then array['*']
    when (select perms from portal_perms) @> array['*'] then array['*']
    else (
      select coalesce(array_agg(distinct k order by k), '{}'::text[])
      from unnest((select perms from role_perms) || (select perms from portal_perms)) as k
    )
  end
$$;

-- Assign a role + optional extra grants. A caller can never grant a permission
-- they do not themselves hold (spec §37). The actor's permissions come from the
-- JWT — never a parameter — and this is service_role-only: the
-- /api/staff/access route is the single caller (it re-checks in JS too).
create or replace function public.set_member_access(
  p_membership_id uuid, p_role text, p_extra text[] default '{}'
) returns text[]
language plpgsql security definer set search_path = public, app as $$
declare
  v_effective text[];
  v_key text;
  v_actor text[] := app.jwt_permissions();
  -- service_role = the /api/staff/access route, which already ran the JS
  -- anti-escalation check with the caller's verified permissions.
  v_all boolean := ('*' = any(v_actor)) or app.jwt_role() = 'service_role';
begin
  if not app.has_perm('permissions.assign') then
    raise exception 'forbidden' using errcode = 'insufficient_privilege';
  end if;
  if not exists (select 1 from public.roles where key = p_role) then
    raise exception 'unknown_role: %', p_role using errcode = 'foreign_key_violation';
  end if;

  v_effective := app.membership_effective_permissions(p_role, p_extra, p_membership_id);

  if not v_all then
    foreach v_key in array v_effective loop
      if not (v_key = any(v_actor)) then
        raise exception 'cannot grant a permission you do not hold: %', v_key
          using errcode = 'insufficient_privilege';
      end if;
    end loop;
  end if;

  update public.memberships
     set role = p_role::app.member_role, extra_permissions = coalesce(p_extra, '{}'::text[])
   where id = p_membership_id;
  if not found then
    raise exception 'membership_not_found' using errcode = 'no_data_found';
  end if;

  perform app.log_action('staff.access', 'memberships', p_membership_id::text, null,
                         jsonb_build_object('role', p_role, 'extra', p_extra));
  return v_effective;
end $$;
revoke all on function public.set_member_access(uuid, text, text[]) from public, authenticated, anon;
grant execute on function public.set_member_access(uuid, text, text[]) to service_role;

alter table public.roles enable row level security;
create policy staff_read on public.roles for select using (app.has_perm('roles.view') or app.is_staff());
-- No can_write() fallback: editing a role's OWN permission array is
-- exactly the self-escalation vector (Manager Portal spec §9) — writing
-- public.roles now requires the caller to explicitly hold roles.update,
-- never just "being a manager". protect_owner_only_permissions below is
-- the second, independent backstop even for a caller who does hold it.
create policy mgr_write on public.roles for all using (app.has_perm('roles.update')) with check (app.has_perm('roles.update'));

create or replace function app.protect_system_roles() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' and old.is_system then
    raise exception 'system roles cannot be deleted';
  elsif tg_op = 'UPDATE' and old.is_system and new.key <> old.key then
    raise exception 'a system role key cannot be changed';
  end if;
  return coalesce(new, old);
end $$;
create trigger protect_system_roles before update or delete on public.roles
  for each row execute function app.protect_system_roles();

-- '*' (unconditional full access — the same marker owner's own row uses)
-- may only ever live on the 'owner' row. This is the server-side
-- backstop for "Owner-only capabilities cannot be granted through
-- Manager portal configuration": it holds even for a caller who legitimately
-- holds roles.update, and even against a direct table write that bypasses
-- routes/staff.ts's own anti-escalation check entirely. Centralized here
-- rather than duplicated in the Roles UI's own validation.
create or replace function app.protect_owner_only_permissions() returns trigger
language plpgsql as $$
begin
  if new.key <> 'owner' and '*' = any(new.permissions) then
    raise exception 'only the owner role may hold unrestricted (*) access' using errcode = 'insufficient_privilege';
  end if;
  return new;
end $$;
create trigger protect_owner_only_permissions before insert or update on public.roles
  for each row execute function app.protect_owner_only_permissions();

-- ── Menu ───────────────────────────────────────────────────────────────────
create table public.menu_categories (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  sort_order int not null default 0,
  created_at timestamptz not null default now()
);

create table public.menu_items (
  id uuid primary key default gen_random_uuid(),
  category_id uuid references public.menu_categories(id) on delete set null,
  name text not null,
  description text,
  image_url text,
  price_cents integer not null default 0 check (price_cents >= 0),  -- base / fallback; real price is on the variant
  is_available boolean not null default true,
  station text,  -- free-text kitchen prep station (Fryer/Grill/...); null = unassigned (0050)
  created_at timestamptz not null default now()
);

-- ── Menu variants (Phase 4) ──────────────────────────────────────────────
-- Every item has >= 1 variant. Price, SKU and (optionally) an availability
-- counter live on the variant. Orders record the exact variant purchased.
create table public.menu_variants (
  id                 uuid primary key default gen_random_uuid(),
  menu_item_id       uuid not null references public.menu_items(id) on delete cascade,
  name               text not null default 'Regular',
  price_cents        integer not null check (price_cents >= 0),
  sku                text,
  sort_order         int not null default 0,
  is_available       boolean not null default true,
  track_availability boolean not null default false,
  available_qty      int not null default 0,
  created_at         timestamptz not null default now()
);
create index menu_variants_item_idx on public.menu_variants(menu_item_id, sort_order);

-- ── Modifiers / add-ons (P10) ────────────────────────────────────────────
-- A group of choices attached to an item — "Choose Size" (required, exactly
-- one), "Toppings" (optional, up to 3), "Add-ons" (optional, any number).
-- Distinct from a variant: a variant is a different purchasable product
-- configuration (own price/SKU/stock); a modifier is a customization or
-- optional addition layered on top of whichever variant was chosen.
create table public.modifier_groups (
  id           uuid primary key default gen_random_uuid(),
  menu_item_id uuid not null references public.menu_items(id) on delete cascade,
  name         text not null,
  kind         app.modifier_kind not null default 'multi',
  min_select   int not null default 0,
  max_select   int,                              -- null = unlimited (kind = 'multi' only)
  sort_order   int not null default 0,
  created_at   timestamptz not null default now(),
  check (kind <> 'required_single' or min_select >= 1),
  check (max_select is null or max_select >= min_select)
);
create index modifier_groups_item_idx on public.modifier_groups(menu_item_id, sort_order);

create table public.modifier_options (
  id           uuid primary key default gen_random_uuid(),
  group_id     uuid not null references public.modifier_groups(id) on delete cascade,
  name         text not null,
  price_cents  int not null default 0 check (price_cents >= 0),
  is_available boolean not null default true,
  sort_order   int not null default 0
);
create index modifier_options_group_idx on public.modifier_options(group_id, sort_order);

-- ── Deals & combos (P7) ─────────────────────────────────────────────────
create table public.deals (
  id                 uuid primary key default gen_random_uuid(),
  name               text not null,
  description        text,
  image_url          text,
  price_cents        int not null check (price_cents >= 0),
  is_available       boolean not null default true,
  track_availability boolean not null default false,
  available_qty      int not null default 0,
  starts_at          timestamptz,
  ends_at            timestamptz,
  sort_order         int not null default 0,
  created_at         timestamptz not null default now()
);

create table public.deal_components (
  id           uuid primary key default gen_random_uuid(),
  deal_id      uuid not null references public.deals(id) on delete cascade,
  menu_item_id uuid references public.menu_items(id) on delete restrict,
  variant_id   uuid references public.menu_variants(id) on delete set null,
  qty          int not null default 1 check (qty > 0),
  sort_order   int not null default 0
);
create index deal_components_deal_idx on public.deal_components(deal_id, sort_order);

-- Build-Your-Own-Combo (spec §8-10): a group of selectable options on top of
-- the deal's fixed components/price ("Choose 1 Main", "Choose 1 Drink").
-- Selecting a premium item can upcharge the deal price; the base fixed
-- price already covers a normal/default selection, matching how a
-- modifier group works for a plain item — this reuses that exact mental
-- model rather than inventing a second one.
create table public.deal_option_groups (
  id         uuid primary key default gen_random_uuid(),
  deal_id    uuid not null references public.deals(id) on delete cascade,
  name       text not null,
  min_select int not null default 1 check (min_select >= 0),
  max_select int check (max_select is null or max_select >= min_select),
  sort_order int not null default 0
);
create index deal_option_groups_deal_idx on public.deal_option_groups(deal_id, sort_order);

create table public.deal_option_items (
  id                     uuid primary key default gen_random_uuid(),
  group_id               uuid not null references public.deal_option_groups(id) on delete cascade,
  menu_item_id           uuid references public.menu_items(id) on delete cascade,
  variant_id             uuid references public.menu_variants(id) on delete cascade,
  qty                    int not null default 1 check (qty > 0),
  -- Upcharges only (never negative) — order_lines.unit_price_cents/
  -- line_total_cents are check(>= 0) everywhere else in this schema, and
  -- the spec's own worked examples are all "+PKR 150" premium upcharges;
  -- a per-option discount is a deferred nuance, not this pass's scope.
  price_adjustment_cents int not null default 0 check (price_adjustment_cents >= 0),
  is_default             boolean not null default false,
  sort_order             int not null default 0
);
create index deal_option_items_group_idx on public.deal_option_items(group_id, sort_order);

alter table public.deal_option_groups enable row level security;
alter table public.deal_option_items enable row level security;
create policy staff_read on public.deal_option_groups for select using (app.has_perm('deals.view') or app.is_staff());
create policy mgr_write  on public.deal_option_groups for all using (app.has_perm('deals.update') or app.can_write()) with check (app.has_perm('deals.update') or app.can_write());
create policy guest_read on public.deal_option_groups for select using (true);
create policy staff_read on public.deal_option_items for select using (app.has_perm('deals.view') or app.is_staff());
create policy mgr_write  on public.deal_option_items for all using (app.has_perm('deals.update') or app.can_write()) with check (app.has_perm('deals.update') or app.can_write());
create policy guest_read on public.deal_option_items for select using (true);

alter table public.deals enable row level security;
alter table public.deal_components enable row level security;
create policy staff_read on public.deals for select using (app.has_perm('deals.view') or app.is_staff());
create policy mgr_write  on public.deals for all using (app.has_perm('deals.update') or app.can_write()) with check (app.has_perm('deals.update') or app.can_write());
create policy guest_read on public.deals for select using (
  is_available and (starts_at is null or starts_at <= now()) and (ends_at is null or ends_at >= now())
);
create policy staff_read on public.deal_components for select using (app.has_perm('deals.view') or app.is_staff());
create policy mgr_write  on public.deal_components for all using (app.has_perm('deals.update') or app.can_write()) with check (app.has_perm('deals.update') or app.can_write());
create policy guest_read on public.deal_components for select using (true);
alter publication supabase_realtime add table public.deals;

-- stock_qty and every recipe/consumption quantity are always in this item's
-- BASE unit (e.g. grams for a weight item, ml for volume, piece for count) —
-- the smallest unit the kitchen actually measures in. Purchasing can happen
-- in a bigger purchase_unit_label (e.g. "KG bag"); purchase_unit_to_base is
-- how many base units one purchase unit converts to, so "10 KG for Rs.5,000"
-- and "150g per burger" resolve on the same footing (spec §6-7) without a
-- general-purpose unit-conversion table. cost_cents_per_base_unit is a
-- weighted average across receipts (spec §8) — the one costing method used
-- everywhere ingredient cost is read, including historical recipe-cost
-- snapshots on order_lines.
create table public.inventory_items (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  sku text unique,
  unit text not null default 'unit',                       -- display label for the base unit (g, ml, piece, ...)
  unit_kind text not null default 'count' check (unit_kind in ('weight', 'volume', 'count')),
  purchase_unit_label text,                                 -- e.g. "KG bag", null = purchased in the base unit directly
  purchase_unit_to_base numeric(14,4) not null default 1 check (purchase_unit_to_base > 0),
  cost_cents_per_base_unit numeric(14,4) not null default 0 check (cost_cents_per_base_unit >= 0),
  stock_qty numeric(14,3) not null default 0,
  min_threshold numeric(14,3) not null default 0,
  supplier_name text,
  created_at timestamptz not null default now()
);

-- A recipe row applies to a specific variant when variant_id is set (spec
-- §11 — Large can need more chicken than Regular); when null it's the
-- item's base recipe, used for any variant that has no override of its own.
-- place_order() picks the variant-specific set if one exists, else falls
-- back to the base set — never both.
create table public.recipe_components (
  id uuid primary key default gen_random_uuid(),
  menu_item_id uuid not null references public.menu_items(id) on delete cascade,
  variant_id uuid references public.menu_variants(id) on delete cascade,
  inventory_item_id uuid not null references public.inventory_items(id) on delete restrict,
  qty_per_unit numeric(14,3) not null check (qty_per_unit > 0),
  unique (menu_item_id, variant_id, inventory_item_id)
);

-- A modifier option can carry its own ingredient consumption on top of the
-- item/variant's base recipe (spec §12 — Extra Cheese consumes one more
-- cheese slice; Extra Patty consumes another 150g of chicken).
create table public.modifier_recipe_components (
  id                  uuid primary key default gen_random_uuid(),
  modifier_option_id  uuid not null references public.modifier_options(id) on delete cascade,
  inventory_item_id   uuid not null references public.inventory_items(id) on delete restrict,
  qty_base            numeric(14,3) not null check (qty_base > 0),
  unique (modifier_option_id, inventory_item_id)
);

-- ── Recipe Management ────────────────────────────────────────────────────
-- Recipes are the authoritative, NAMED, VERSIONED definition of what a menu
-- item (or a semi-finished/prep component) consumes. They sit ABOVE
-- recipe_components, not beside it: recipe_components stays exactly what
-- place_order() already reads (untouched — the order/consumption/COGS
-- pipeline built earlier keeps working exactly as before), and activating
-- a recipe version SYNCS its resolved ingredient list into
-- recipe_components for the (menu_item_id, variant_id) it targets. That
-- avoids a second, divergent consumption system while adding real naming,
-- status and version history recipe_components alone can't express.
--
-- Ingredient quantities (recipe_ingredients.qty_base) are always in the
-- target's own BASE unit — the exact same convention inventory_items and
-- recipe_components already use (spec §6-7's "150g per burger" resolves
-- against inventory_items.unit directly). There is deliberately no second
-- unit-conversion system: a recipe line never offers a choice of unit to
-- convert FROM, so an incompatible conversion (spec §9 — "150 ml against a
-- kg-based item") has no way to be expressed in the first place, rather
-- than being entered and then rejected.
create type app.recipe_type as enum ('menu_item', 'variant', 'semi_finished', 'preparation');
create type app.recipe_status as enum ('draft', 'active', 'archived');

-- The recipe's stable identity: its name, what it's for, and — for a
-- menu_item/variant recipe — which product it defines. current_version_id
-- is maintained by activate_recipe_version(); status mirrors whichever
-- version is current (draft until something is activated, archived once
-- the whole recipe is retired).
create table public.recipes (
  id                  uuid primary key default gen_random_uuid(),
  name                text not null,
  description         text,
  notes               text,
  recipe_type         app.recipe_type not null default 'menu_item',
  menu_item_id        uuid references public.menu_items(id) on delete cascade,
  variant_id          uuid references public.menu_variants(id) on delete cascade,
  status              app.recipe_status not null default 'draft',
  current_version_id  uuid,
  instructions        text,
  created_by          uuid,
  created_at          timestamptz not null default now(),
  -- A menu_item/variant recipe must point at a product; a semi_finished/
  -- preparation recipe (a batch other recipes consume FROM) must not.
  check ((recipe_type in ('menu_item','variant')) = (menu_item_id is not null)),
  check (recipe_type = 'variant' or variant_id is null)
);
create index recipes_menu_item_idx on public.recipes(menu_item_id, variant_id);
-- At most one non-archived recipe per product — matches recipe_components'
-- own (menu_item_id, variant_id) uniqueness, so there is never ambiguity
-- about which recipe a product's consumption comes from.
create unique index recipes_one_live_per_product_idx on public.recipes(menu_item_id, coalesce(variant_id, '00000000-0000-0000-0000-000000000000'))
  where status <> 'archived' and recipe_type in ('menu_item', 'variant');

-- One row per version ever created for a recipe (spec §16's historical
-- ledger). Only one version per recipe is ever 'active'; activate_recipe_
-- version() enforces that by archiving whichever one currently holds it.
-- effective_from/effective_to record exactly when each version was live,
-- for cost-history and "what recipe made this order" questions.
create table public.recipe_versions (
  id              uuid primary key default gen_random_uuid(),
  recipe_id       uuid not null references public.recipes(id) on delete cascade,
  version         int not null check (version > 0),
  status          app.recipe_status not null default 'draft',
  yield_qty       numeric(14,3) not null default 1 check (yield_qty > 0),
  yield_unit      text,  -- display label; null = "1 serving" for a menu_item/variant recipe
  effective_from  timestamptz,
  effective_to    timestamptz,
  created_by      uuid,
  created_at      timestamptz not null default now(),
  unique (recipe_id, version)
);
create index recipe_versions_recipe_idx on public.recipe_versions(recipe_id, version desc);
alter table public.recipes add constraint recipes_current_version_fk
  foreign key (current_version_id) references public.recipe_versions(id) on delete set null;

-- One ingredient line in a recipe version — either a raw inventory item or
-- a sub-recipe (a semi_finished/preparation recipe this line draws its
-- yield from), never both (spec §12-13).
create table public.recipe_ingredients (
  id                  uuid primary key default gen_random_uuid(),
  recipe_version_id   uuid not null references public.recipe_versions(id) on delete cascade,
  inventory_item_id   uuid references public.inventory_items(id) on delete restrict,
  sub_recipe_id       uuid references public.recipes(id) on delete restrict,
  qty_base            numeric(14,3) not null check (qty_base > 0),
  sort_order          int not null default 0,
  check ((inventory_item_id is null) <> (sub_recipe_id is null))
);
create index recipe_ingredients_version_idx on public.recipe_ingredients(recipe_version_id, sort_order);
-- No duplicate ingredient rows within one version (spec §28).
create unique index recipe_ingredients_unique_item_idx on public.recipe_ingredients(recipe_version_id, inventory_item_id) where inventory_item_id is not null;
create unique index recipe_ingredients_unique_sub_idx on public.recipe_ingredients(recipe_version_id, sub_recipe_id) where sub_recipe_id is not null;

-- Append-only recipe cost history (spec §24, §26): one row whenever a
-- version's computed cost differs from the last logged value for it —
-- written at activation and by the periodic snapshot sweep (server-side,
-- mirrors the low-stock sweep), so an ingredient price change ALONE, with
-- no recipe edit at all, still shows up as a tracked cost change.
create table public.recipe_cost_log (
  id                  uuid primary key default gen_random_uuid(),
  recipe_version_id   uuid not null references public.recipe_versions(id) on delete cascade,
  cost_cents          int not null,
  recorded_at         timestamptz not null default now()
);
create index recipe_cost_log_version_idx on public.recipe_cost_log(recipe_version_id, recorded_at desc);

-- Explodes a recipe version down to raw inventory quantities, resolving
-- any sub-recipe ingredient through ITS active version and yield (spec
-- §12-13 semi-finished/preparation support) — this is what
-- activate_recipe_version() writes into recipe_components. p_visited
-- guards against a circular chain looping forever; activate_recipe_
-- version() already refuses to activate anything that would create one,
-- so this is defense in depth, not the primary guard.
create or replace function public.resolve_recipe_ingredients(p_recipe_version_id uuid, p_multiplier numeric default 1, p_visited uuid[] default '{}')
returns table (inventory_item_id uuid, qty_base numeric)
language plpgsql stable security definer set search_path = public, app as $fn$
declare
  v_line record;
  v_sub_active uuid;
  v_sub_yield numeric;
begin
  if p_recipe_version_id = any(p_visited) then
    return;
  end if;
  for v_line in
    select ri.qty_base as q, ri.inventory_item_id as ii, ri.sub_recipe_id as sr
      from public.recipe_ingredients ri
     where ri.recipe_version_id = p_recipe_version_id
  loop
    if v_line.ii is not null then
      inventory_item_id := v_line.ii;
      qty_base := v_line.q * p_multiplier;
      return next;
    else
      select r.current_version_id into v_sub_active from public.recipes r where r.id = v_line.sr;
      if v_sub_active is not null then
        select rv.yield_qty into v_sub_yield from public.recipe_versions rv where rv.id = v_sub_active;
        return query select * from public.resolve_recipe_ingredients(
          v_sub_active,
          p_multiplier * v_line.q / greatest(coalesce(v_sub_yield, 1), 0.0001),
          p_visited || p_recipe_version_id
        );
      end if;
    end if;
  end loop;
end;
$fn$;

-- Total cost to produce one full batch (yield_qty units) of a recipe
-- version — divide by yield_qty for cost-per-yield-unit (cost per serving
-- for a menu_item/variant recipe, since those always yield 1).
create or replace function public.recipe_version_total_cost(p_recipe_version_id uuid)
returns int language sql stable security definer set search_path = public, app as $fn$
  select coalesce(sum(round(x.qty_base * coalesce(i.cost_cents_per_base_unit, 0))), 0)::int
    from public.resolve_recipe_ingredients(p_recipe_version_id) x
    join public.inventory_items i on i.id = x.inventory_item_id;
$fn$;
grant execute on function public.recipe_version_total_cost(uuid) to authenticated, service_role;

create or replace function public.recipe_version_cost_per_yield_unit(p_recipe_version_id uuid)
returns int language sql stable security definer set search_path = public, app as $fn$
  select round(public.recipe_version_total_cost(p_recipe_version_id) / greatest(rv.yield_qty, 0.0001))::int
    from public.recipe_versions rv where rv.id = p_recipe_version_id;
$fn$;
grant execute on function public.recipe_version_cost_per_yield_unit(uuid) to authenticated, service_role;

-- Create a new recipe as a draft, with its first version and ingredient
-- list, in one transaction (spec §52 "select item -> add ingredients ->
-- system calculates cost -> review -> save").
create or replace function public.create_recipe(
  p_name text, p_description text, p_notes text, p_recipe_type app.recipe_type,
  p_menu_item_id uuid, p_variant_id uuid, p_instructions text,
  p_yield_qty numeric, p_yield_unit text, p_ingredients jsonb
) returns table (recipe_id uuid, recipe_version_id uuid, cost_cents int)
language plpgsql security definer set search_path = public, app as $fn$
declare
  v_recipe_id uuid; v_version_id uuid; v_ing jsonb; v_cost int;
begin
  -- Recipes & Food Cost is an opt-in domain for Manager (Owner's Portal
  -- & Access Control grants it per-manager) — no can_write() fallback.
  if not (app.has_perm('inventory.manage_recipes') or app.has_perm('finance.manage_recipes')) then
    raise exception 'forbidden' using errcode = 'insufficient_privilege';
  end if;
  if coalesce(trim(p_name), '') = '' then
    raise exception 'recipe_name_required' using errcode = 'check_violation';
  end if;
  if p_ingredients is null or jsonb_typeof(p_ingredients) <> 'array' or jsonb_array_length(p_ingredients) = 0 then
    raise exception 'recipe_needs_ingredients' using errcode = 'check_violation';
  end if;
  if p_recipe_type in ('menu_item', 'variant') and p_menu_item_id is null then
    raise exception 'recipe_needs_menu_item' using errcode = 'check_violation';
  end if;

  insert into public.recipes (name, description, notes, recipe_type, menu_item_id, variant_id, instructions, status, created_by)
  values (trim(p_name), nullif(trim(coalesce(p_description, '')), ''), nullif(trim(coalesce(p_notes, '')), ''),
          p_recipe_type, p_menu_item_id, p_variant_id, nullif(trim(coalesce(p_instructions, '')), ''), 'draft', app.jwt_sub())
  returning id into v_recipe_id;

  insert into public.recipe_versions (recipe_id, version, status, yield_qty, yield_unit, created_by)
  values (v_recipe_id, 1, 'draft', greatest(coalesce(p_yield_qty, 1), 0.0001), nullif(trim(coalesce(p_yield_unit, '')), ''), app.jwt_sub())
  returning id into v_version_id;

  for v_ing in select * from jsonb_array_elements(p_ingredients) loop
    insert into public.recipe_ingredients (recipe_version_id, inventory_item_id, sub_recipe_id, qty_base, sort_order)
    values (
      v_version_id,
      nullif(v_ing->>'inventory_item_id', '')::uuid,
      nullif(v_ing->>'sub_recipe_id', '')::uuid,
      (v_ing->>'qty_base')::numeric,
      coalesce((v_ing->>'sort_order')::int, 0)
    );
  end loop;

  v_cost := public.recipe_version_total_cost(v_version_id);
  perform app.log_action('recipe.created', 'recipes', v_recipe_id::text, null,
    jsonb_build_object('name', p_name, 'version_id', v_version_id, 'cost_cents', v_cost));

  return query select v_recipe_id, v_version_id, v_cost;
end;
$fn$;
revoke all on function public.create_recipe(text, text, text, app.recipe_type, uuid, uuid, text, numeric, text, jsonb) from public;
grant execute on function public.create_recipe(text, text, text, app.recipe_type, uuid, uuid, text, numeric, text, jsonb) to authenticated, service_role;

-- Create a new DRAFT version of an existing recipe, carrying forward the
-- previous version's yield unless overridden (spec §16 — editing a recipe
-- never overwrites history, it creates the next version).
create or replace function public.create_recipe_version(
  p_recipe_id uuid, p_ingredients jsonb, p_yield_qty numeric default null, p_yield_unit text default null
) returns table (recipe_version_id uuid, cost_cents int)
language plpgsql security definer set search_path = public, app as $fn$
declare
  v_next_version int; v_version_id uuid; v_ing jsonb; v_cost int;
  v_prev_yield_qty numeric; v_prev_yield_unit text;
begin
  -- Recipes & Food Cost is an opt-in domain for Manager (Owner's Portal
  -- & Access Control grants it per-manager) — no can_write() fallback.
  if not (app.has_perm('inventory.manage_recipes') or app.has_perm('finance.manage_recipes')) then
    raise exception 'forbidden' using errcode = 'insufficient_privilege';
  end if;
  if not exists (select 1 from public.recipes where id = p_recipe_id) then
    raise exception 'recipe_not_found' using errcode = 'no_data_found';
  end if;
  if p_ingredients is null or jsonb_typeof(p_ingredients) <> 'array' or jsonb_array_length(p_ingredients) = 0 then
    raise exception 'recipe_needs_ingredients' using errcode = 'check_violation';
  end if;

  select coalesce(max(version), 0) + 1 into v_next_version from public.recipe_versions where recipe_id = p_recipe_id;
  select yield_qty, yield_unit into v_prev_yield_qty, v_prev_yield_unit
    from public.recipe_versions where recipe_id = p_recipe_id order by version desc limit 1;

  insert into public.recipe_versions (recipe_id, version, status, yield_qty, yield_unit, created_by)
  values (p_recipe_id, v_next_version, 'draft',
          greatest(coalesce(p_yield_qty, v_prev_yield_qty, 1), 0.0001),
          coalesce(nullif(trim(coalesce(p_yield_unit, '')), ''), v_prev_yield_unit), app.jwt_sub())
  returning id into v_version_id;

  for v_ing in select * from jsonb_array_elements(p_ingredients) loop
    insert into public.recipe_ingredients (recipe_version_id, inventory_item_id, sub_recipe_id, qty_base, sort_order)
    values (
      v_version_id,
      nullif(v_ing->>'inventory_item_id', '')::uuid,
      nullif(v_ing->>'sub_recipe_id', '')::uuid,
      (v_ing->>'qty_base')::numeric,
      coalesce((v_ing->>'sort_order')::int, 0)
    );
  end loop;

  v_cost := public.recipe_version_total_cost(v_version_id);
  perform app.log_action('recipe.version_created', 'recipes', p_recipe_id::text, null,
    jsonb_build_object('version', v_next_version, 'version_id', v_version_id, 'cost_cents', v_cost));

  return query select v_version_id, v_cost;
end;
$fn$;
revoke all on function public.create_recipe_version(uuid, jsonb, numeric, text) from public;
grant execute on function public.create_recipe_version(uuid, jsonb, numeric, text) to authenticated, service_role;

-- Make a draft version the live one (spec §17-18). Validates ingredients
-- exist and the recipe has a product to attach to, rejects a version whose
-- sub-recipe chain would become circular (spec §29), archives whichever
-- version currently holds 'active', and — for a menu_item/variant recipe —
-- syncs the resolved (sub-recipes exploded to raw quantities) ingredient
-- list into recipe_components, which is ALL place_order() ever reads. This
-- is the one place a recipe change becomes live production consumption.
create or replace function public.activate_recipe_version(p_recipe_version_id uuid)
returns void language plpgsql security definer set search_path = public, app as $fn$
declare
  v_recipe_id uuid; v_recipe public.recipes; v_prev_active uuid; v_cost int;
begin
  -- Recipes & Food Cost is an opt-in domain for Manager (Owner's Portal
  -- & Access Control grants it per-manager) — no can_write() fallback.
  if not (app.has_perm('inventory.manage_recipes') or app.has_perm('finance.manage_recipes')) then
    raise exception 'forbidden' using errcode = 'insufficient_privilege';
  end if;

  select recipe_id into v_recipe_id from public.recipe_versions where id = p_recipe_version_id;
  if v_recipe_id is null then raise exception 'recipe_version_not_found' using errcode = 'no_data_found'; end if;
  select * into v_recipe from public.recipes where id = v_recipe_id;

  if not exists (select 1 from public.recipe_ingredients where recipe_version_id = p_recipe_version_id) then
    raise exception 'recipe_needs_ingredients' using errcode = 'check_violation';
  end if;
  if v_recipe.recipe_type in ('menu_item', 'variant') and v_recipe.menu_item_id is null then
    raise exception 'recipe_needs_menu_item' using errcode = 'check_violation';
  end if;

  -- Circular-dependency guard: walk the sub-recipe graph this version
  -- would introduce (through OTHER recipes' currently-active versions —
  -- a draft elsewhere doesn't count until it too is activated, at which
  -- point this same check runs for it) and refuse if it ever leads back
  -- to this recipe.
  if exists (
    with recursive dep(recipe_id) as (
      select ri.sub_recipe_id from public.recipe_ingredients ri
       where ri.recipe_version_id = p_recipe_version_id and ri.sub_recipe_id is not null
      union
      select ri2.sub_recipe_id
        from dep
        join public.recipes r2 on r2.id = dep.recipe_id
        join public.recipe_ingredients ri2
          on ri2.recipe_version_id = coalesce(r2.current_version_id, '00000000-0000-0000-0000-000000000000'::uuid)
         and ri2.sub_recipe_id is not null
    )
    select 1 from dep where recipe_id = v_recipe_id
  ) then
    raise exception 'circular_recipe_dependency' using errcode = 'check_violation';
  end if;

  select id into v_prev_active from public.recipe_versions where recipe_id = v_recipe_id and status = 'active';
  if v_prev_active is not null then
    update public.recipe_versions set status = 'archived', effective_to = now() where id = v_prev_active;
  end if;
  update public.recipe_versions set status = 'active', effective_from = now(), effective_to = null where id = p_recipe_version_id;
  update public.recipes set status = 'active', current_version_id = p_recipe_version_id where id = v_recipe_id;

  if v_recipe.recipe_type in ('menu_item', 'variant') then
    delete from public.recipe_components
     where menu_item_id = v_recipe.menu_item_id and variant_id is not distinct from v_recipe.variant_id;
    insert into public.recipe_components (menu_item_id, variant_id, inventory_item_id, qty_per_unit)
    select v_recipe.menu_item_id, v_recipe.variant_id, x.inventory_item_id, sum(x.qty_base)
      from public.resolve_recipe_ingredients(p_recipe_version_id) x
     group by x.inventory_item_id;
  end if;

  v_cost := public.recipe_version_total_cost(p_recipe_version_id);
  insert into public.recipe_cost_log (recipe_version_id, cost_cents) values (p_recipe_version_id, v_cost);

  perform app.log_action('recipe.activated', 'recipes', v_recipe_id::text,
    jsonb_build_object('previous_version_id', v_prev_active),
    jsonb_build_object('active_version_id', p_recipe_version_id, 'cost_cents', v_cost));
end;
$fn$;
revoke all on function public.activate_recipe_version(uuid) from public;
grant execute on function public.activate_recipe_version(uuid) to authenticated, service_role;

-- Retire a recipe entirely (spec §17): removes it from what place_order()
-- can consume (deletes its recipe_components rows for menu_item/variant
-- recipes) but never touches order_lines.recipe_cost_cents snapshots or
-- recipe_versions history — those stay exactly as they were.
create or replace function public.archive_recipe(p_recipe_id uuid)
returns void language plpgsql security definer set search_path = public, app as $fn$
declare v_recipe public.recipes;
begin
  -- Recipes & Food Cost is an opt-in domain for Manager (Owner's Portal
  -- & Access Control grants it per-manager) — no can_write() fallback.
  if not (app.has_perm('inventory.manage_recipes') or app.has_perm('finance.manage_recipes')) then
    raise exception 'forbidden' using errcode = 'insufficient_privilege';
  end if;
  select * into v_recipe from public.recipes where id = p_recipe_id;
  if v_recipe.id is null then raise exception 'recipe_not_found' using errcode = 'no_data_found'; end if;

  update public.recipes set status = 'archived' where id = p_recipe_id;
  update public.recipe_versions set status = 'archived', effective_to = coalesce(effective_to, now())
   where recipe_id = p_recipe_id and status = 'active';

  if v_recipe.recipe_type in ('menu_item', 'variant') then
    delete from public.recipe_components
     where menu_item_id = v_recipe.menu_item_id and variant_id is not distinct from v_recipe.variant_id;
  end if;

  perform app.log_action('recipe.archived', 'recipes', p_recipe_id::text, null, null);
end;
$fn$;
revoke all on function public.archive_recipe(uuid) from public;
grant execute on function public.archive_recipe(uuid) to authenticated, service_role;

-- Periodic sweep (spec §24, §35 — cost-change detection independent of any
-- recipe edit, e.g. a supplier price change alone): logs a new
-- recipe_cost_log row for every active recipe version whose computed cost
-- has moved since it was last logged. Called by the server's scheduled
-- sweep (mirrors the low-stock sweep) — service_role only, not a
-- staff-facing RPC.
create or replace function public.snapshot_recipe_cost_changes()
returns table (recipe_id uuid, recipe_version_id uuid, previous_cost_cents int, new_cost_cents int)
language plpgsql security definer set search_path = public, app as $fn$
declare
  v_rv record; v_new_cost int; v_last_cost int;
begin
  -- source_recipe_id (not recipe_id) — the OUT param recipe_id shares this
  -- function's scope, and a bare/ambiguously-named column reference here
  -- resolves against the OUT param instead of the query, same footgun
  -- fixed elsewhere in this file: always alias distinctly, never bare.
  for v_rv in select rv.id as version_id, rv.recipe_id as source_recipe_id from public.recipe_versions rv where rv.status = 'active' loop
    v_new_cost := public.recipe_version_total_cost(v_rv.version_id);
    select rcl.cost_cents into v_last_cost from public.recipe_cost_log rcl
     where rcl.recipe_version_id = v_rv.version_id order by rcl.recorded_at desc limit 1;
    if v_last_cost is null or v_last_cost <> v_new_cost then
      insert into public.recipe_cost_log (recipe_version_id, cost_cents) values (v_rv.version_id, v_new_cost);
      recipe_id := v_rv.source_recipe_id;
      recipe_version_id := v_rv.version_id;
      previous_cost_cents := v_last_cost;
      new_cost_cents := v_new_cost;
      return next;
    end if;
  end loop;
end;
$fn$;
revoke all on function public.snapshot_recipe_cost_changes() from public;
grant execute on function public.snapshot_recipe_cost_changes() to service_role;

-- The most recent meaningful cost move (>= p_min_pct, or any move off a
-- previously-zero cost) for every active recipe, comparing its two most
-- recent recipe_cost_log entries — powers AI Management's "recipe cost
-- alert" (spec §35) and the AI assistant's "why did my recipe cost
-- change" questions, both reading the SAME evidence, never a separate
-- calculation.
create or replace function public.recipe_recent_cost_changes(p_min_pct numeric default 5)
returns table (
  recipe_id uuid, name text, recipe_version_id uuid,
  previous_cost_cents int, new_cost_cents int, change_cents int, change_pct numeric
)
language plpgsql stable security definer set search_path = public, app as $fn$
begin
  if not app.has_perm('inventory.view_cost') then
    raise exception 'forbidden' using errcode = 'insufficient_privilege';
  end if;
  return query
    with ranked as (
      select rcl.recipe_version_id as rv_id, rcl.cost_cents as c,
             row_number() over (partition by rcl.recipe_version_id order by rcl.recorded_at desc) as rn
        from public.recipe_cost_log rcl
        join public.recipe_versions rv on rv.id = rcl.recipe_version_id and rv.status = 'active'
    ),
    paired as (
      select a.rv_id as rvid, b.c as prev_cost, a.c as curr_cost
        from ranked a
        join ranked b on b.rv_id = a.rv_id and b.rn = 2
       where a.rn = 1
    )
    select r.id, r.name, p.rvid, p.prev_cost, p.curr_cost, p.curr_cost - p.prev_cost,
           case when p.prev_cost > 0
                then round((p.curr_cost - p.prev_cost)::numeric / p.prev_cost * 1000) / 10
                else null end
      from paired p
      join public.recipe_versions rv on rv.id = p.rvid
      join public.recipes r on r.id = rv.recipe_id
     where p.prev_cost is distinct from p.curr_cost
       and (
         p.prev_cost = 0
         or abs(p.curr_cost - p.prev_cost)::numeric / greatest(p.prev_cost, 1) * 100 >= p_min_pct
       )
     order by abs(p.curr_cost - p.prev_cost) desc;
end;
$fn$;
revoke all on function public.recipe_recent_cost_changes(numeric) from public;
grant execute on function public.recipe_recent_cost_changes(numeric) to authenticated, service_role;

alter table public.recipes enable row level security;
create policy staff_read on public.recipes for select using (app.has_perm('menu.view') or app.is_staff());
create policy mgr_write on public.recipes for all
  using (app.has_perm('inventory.manage_recipes') or app.has_perm('finance.manage_recipes'))
  with check (app.has_perm('inventory.manage_recipes') or app.has_perm('finance.manage_recipes'));

alter table public.recipe_versions enable row level security;
create policy staff_read on public.recipe_versions for select using (app.has_perm('menu.view') or app.is_staff());
create policy mgr_write on public.recipe_versions for all
  using (app.has_perm('inventory.manage_recipes') or app.has_perm('finance.manage_recipes'))
  with check (app.has_perm('inventory.manage_recipes') or app.has_perm('finance.manage_recipes'));

alter table public.recipe_ingredients enable row level security;
create policy staff_read on public.recipe_ingredients for select using (app.has_perm('menu.view') or app.is_staff());
create policy mgr_write on public.recipe_ingredients for all
  using (app.has_perm('inventory.manage_recipes') or app.has_perm('finance.manage_recipes'))
  with check (app.has_perm('inventory.manage_recipes') or app.has_perm('finance.manage_recipes'));

-- Cost figures only, unlike the tables above — gated on inventory.view_cost
-- (not menu.view) so kitchen-only roles see recipes/instructions but not
-- the cost trend, matching how InventoryManager already hides dollar
-- columns from roles without inventory.view_cost.
alter table public.recipe_cost_log enable row level security;
-- Cost history is dollar data — same narrow finance-style exception,
-- no can_write() fallback, so it respects a manager's actual
-- inventory.view_cost grant rather than their role name.
create policy staff_read on public.recipe_cost_log for select using (app.has_perm('inventory.view_cost'));

-- ── Orders ─────────────────────────────────────────────────────────────────
create table public.order_counter (
  id boolean primary key default true check (id),   -- single row
  next_number bigint not null default 1
);
insert into public.order_counter default values;

-- A table's live tab: every order placed for that table while a session is open
-- is grouped under it, so staff see one combined bill.
create table public.table_sessions (
  id          uuid primary key default gen_random_uuid(),
  table_label text not null,
  status      text not null default 'open' check (status in ('open', 'closed')),
  opened_at   timestamptz not null default now(),
  closed_at   timestamptz
);
create index table_sessions_open_idx on public.table_sessions(table_label) where status = 'open';

create table public.orders (
  id uuid primary key default gen_random_uuid(),
  order_number bigint not null unique,
  session_id uuid references public.table_sessions(id) on delete set null,
  channel app.order_channel not null default 'dine_in',
  table_label text,
  customer_name text,
  customer_note text,                               -- guest instructions, untrusted text
  status app.order_status not null default 'pending',
  subtotal_cents integer not null default 0 check (subtotal_cents >= 0),
  tax_cents integer not null default 0 check (tax_cents >= 0),
  tax_rate_bps integer not null default 0,          -- effective rate, for later recalculation
  total_cents integer not null default 0 check (total_cents >= 0),
  refunded_cents integer not null default 0 check (refunded_cents >= 0),
  payment_method text,
  paid_at timestamptz,
  pickup_counter_portal_id uuid,                    -- which checkout counter Kitchen assigned this order to
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index orders_created_idx on public.orders(created_at desc);
create index orders_status_idx on public.orders(status);

create table public.order_lines (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete cascade,
  menu_item_id uuid references public.menu_items(id) on delete set null,
  variant_id uuid references public.menu_variants(id) on delete set null,
  name_snapshot text not null,
  variant_name_snapshot text,
  unit_price_cents integer not null check (unit_price_cents >= 0),
  qty integer not null check (qty > 0),
  line_total_cents integer not null check (line_total_cents >= 0),
  modifiers jsonb not null default '[]'::jsonb,
  customer_note text,                               -- per-item guest instruction, untrusted
  deal_id uuid references public.deals(id) on delete set null,   -- set on a deal's header + component lines
  kds_status app.line_status not null default 'queued',
  -- Ingredient cost consumed for this line, computed from each inventory
  -- item's cost_cents_per_base_unit AT THE MOMENT the order was placed and
  -- never recalculated — historical food-cost integrity (spec §10, §51):
  -- if ingredient costs or the recipe change later, old orders keep the
  -- cost that actually applied. Null when the line has no recipe (e.g. a
  -- deal header row, or an item with no ingredients configured).
  recipe_cost_cents int,
  created_at timestamptz not null default now()
);
create index order_lines_order_idx on public.order_lines(order_id);
create index order_lines_kds_idx on public.order_lines(kds_status);

-- Keeps order_lines.kds_status in sync with orders.status on EVERY write
-- path (the kitchen_* RPCs below update both explicitly already; this
-- trigger is what also covers a direct orders.status write, e.g. from the
-- Orders page, which is independently permissioned from kitchen.update_status
-- — see tenant-migrations/0051 for the full rationale).
--
-- Deliberately no 'in_kitchen' branch: place_order() itself finalizes
-- EVERY new order at status='in_kitchen' as its own last step — 'pending'
-- never exists outside that one transaction. A cascade on transitions TO
-- 'in_kitchen' would fire on every order's creation, not a genuine
-- "kitchen started this" action, wrongly advancing every line straight to
-- preparing before anyone touched it. kitchen_start_order() already does
-- its own queued->preparing cascade explicitly; this trigger only needs
-- 'ready'/'served', the two transitions that genuinely happen once, after
-- an order is already active.
create function app.sync_order_lines_status()
returns trigger
language plpgsql
security definer set search_path = public, app
as $$
begin
  if new.status is distinct from old.status then
    if new.status = 'ready' then
      update public.order_lines set kds_status = 'ready'
       where order_id = new.id and kds_status not in ('ready', 'served');
    elsif new.status = 'served' then
      update public.order_lines set kds_status = 'served'
       where order_id = new.id and kds_status <> 'served';
    end if;
  end if;
  return new;
end;
$$;
create trigger sync_order_lines_status
  after update of status on public.orders
  for each row
  execute function app.sync_order_lines_status();

create table public.stock_ledger (
  id uuid primary key default gen_random_uuid(),
  inventory_item_id uuid not null references public.inventory_items(id) on delete restrict,
  delta_qty numeric(14,3) not null,
  reason app.stock_reason not null,
  order_id uuid references public.orders(id) on delete set null,
  note text,
  -- Cost basis this movement was valued at, in cents per base unit: the
  -- actual receipt price for a purchase, the weighted-average cost at that
  -- moment for consumption/waste/adjustment. Nullable (older rows predate
  -- this column). This is what lets Actual COGS/purchases/waste value be
  -- read straight off the ledger instead of reconstructing historical stock
  -- balances (spec §8, §30 — theoretical vs actual COGS).
  unit_cost_cents_base numeric(14,4),
  created_at timestamptz not null default now()
);
create index stock_ledger_item_idx on public.stock_ledger(inventory_item_id, created_at desc);

create table public.outbox (
  id bigint generated always as identity primary key,
  topic text not null,
  payload jsonb not null,
  created_at timestamptz not null default now(),
  processed_at timestamptz,
  attempts int not null default 0,
  last_error text
);
create index outbox_unprocessed_idx on public.outbox(created_at) where processed_at is null;

create table public.restaurant_tables (
  id         uuid primary key default gen_random_uuid(),
  label      text not null unique,
  seats      int not null default 2 check (seats > 0),
  sort_order int not null default 0,
  created_at timestamptz not null default now()
);

create table public.reservations (
  id uuid primary key default gen_random_uuid(),
  customer_name text not null,
  phone text,
  email text,
  party_size int not null check (party_size > 0),
  reserved_at timestamptz not null,
  duration_min int not null default 90 check (duration_min > 0),
  table_label text,
  occasion text,
  notes text,
  status app.reservation_status not null default 'pending',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index reservations_time_idx on public.reservations(reserved_at);

-- ── RLS: permission-gated, with a legacy fallback (P3) ────────────────────
-- Every policy is  (app.has_perm(key))  OR  (the pre-P3 is_staff/can_write
-- check). A JWT with no explicit app_metadata.permissions array behaves exactly
-- as before; a JWT that carries one (portal users; back-filled staff) is gated
-- strictly to its keys ('*' = all).
do $$
declare r record;
begin
  for r in select * from (values
    ('memberships',       'staff.view',  'staff.update'),
    ('menu_categories',   'menu.view',   'menu.update'),
    ('menu_items',        'menu.view',   'menu.update'),
    ('menu_variants',     'menu.view',   'menu.update'),
    ('modifier_groups',   'menu.view',   'menu.update'),
    ('modifier_options',  'menu.view',   'menu.update'),
    ('inventory_items',   'stock.view',  'stock.update'),
    ('recipe_components', 'menu.view',   'menu.update'),
    ('modifier_recipe_components', 'menu.view', 'menu.update'),
    ('reservations',      'tables.view', 'tables.update'),
    ('restaurant_tables', 'tables.view', 'tables.update')
  ) as t(tbl, rk, wk) loop
    execute format('alter table public.%I enable row level security;', r.tbl);
    execute format(
      'create policy staff_read on public.%I for select using (app.has_perm(%L) or app.is_staff());',
      r.tbl, r.rk);
    execute format(
      'create policy mgr_write on public.%I for all using (app.has_perm(%L) or app.can_write()) with check (app.has_perm(%L) or app.can_write());',
      r.tbl, r.wk, r.wk);
  end loop;
end $$;

-- Storefront menu: readable by anon so the guest QR page and the public
-- /menu API work without any privileged key. Categories are harmless; items
-- are limited to those on sale.
create policy guest_read on public.menu_categories for select using (true);
create policy guest_read on public.menu_items for select using (is_available);
create policy guest_read on public.menu_variants for select using (is_available);
create policy guest_read on public.modifier_groups for select using (true);
create policy guest_read on public.modifier_options for select using (true);

-- Menu image storage: public bucket (served to anonymous storefront guests,
-- same trust level as the rest of the guest-readable menu), staff-only writes.
insert into storage.buckets (id, name, public)
values ('menu-images', 'menu-images', true)
on conflict (id) do nothing;
create policy "menu-images public read" on storage.objects for select
  using (bucket_id = 'menu-images');
create policy "menu-images staff write" on storage.objects for all
  using (bucket_id = 'menu-images' and (app.has_perm('menu.update') or app.can_write()))
  with check (bucket_id = 'menu-images' and (app.has_perm('menu.update') or app.can_write()));

-- Receipt/branding logo storage (0045): public read (shown on a printed/PDF
-- receipt handed to a guest), write gated to settings.update — no
-- can_write() fallback, matching business_settings' own write policy below
-- (Policies is an ownerOnly page in the web app besides).
insert into storage.buckets (id, name, public)
values ('branding', 'branding', true)
on conflict (id) do nothing;
create policy "branding public read" on storage.objects for select
  using (bucket_id = 'branding');
create policy "branding settings write" on storage.objects for all
  using (bucket_id = 'branding' and app.has_perm('settings.update'))
  with check (bucket_id = 'branding' and app.has_perm('settings.update'));

-- ── AI Menu Import ───────────────────────────────────────────────────────
-- A document-derived menu draft: file (PDF text today) -> LLM structuring
-- -> validation -> diff against the LIVE menu -> owner review -> selective
-- apply. Applying writes to the SAME menu_categories/menu_items/
-- menu_variants/modifier_groups/modifier_options tables the manual Menu
-- page uses — there is no AI-only menu store. extracted_json/diff_json are
-- kept after the draft is applied or rejected, for review and audit.
create type app.menu_import_status as enum ('draft', 'ready_for_review', 'applied', 'rejected', 'failed');

create table public.menu_import_drafts (
  id              uuid primary key default gen_random_uuid(),
  source_filename text not null,
  storage_path    text not null,
  extracted_json  jsonb not null,
  diff_json       jsonb not null,
  status          app.menu_import_status not null default 'ready_for_review',
  error           text,
  created_by      uuid,
  created_at      timestamptz not null default now(),
  applied_at      timestamptz,
  applied_by      uuid
);
alter table public.menu_import_drafts enable row level security;
create policy staff_read on public.menu_import_drafts for select using (app.has_perm('menu.view') or app.is_staff());
create policy mgr_write on public.menu_import_drafts for all
  using (app.has_perm('menu.create') or app.has_perm('menu.update') or app.can_write())
  with check (app.has_perm('menu.create') or app.has_perm('menu.update') or app.can_write());

-- Private, staff-only storage for uploaded source documents (unlike
-- menu-images, these are internal source material, never customer-facing).
insert into storage.buckets (id, name, public)
values ('menu-imports', 'menu-imports', false)
on conflict (id) do nothing;
create policy "menu-imports staff read" on storage.objects for select
  using (bucket_id = 'menu-imports' and (app.has_perm('menu.view') or app.is_staff()));
create policy "menu-imports staff write" on storage.objects for all
  using (bucket_id = 'menu-imports' and (app.has_perm('menu.create') or app.has_perm('menu.update') or app.can_write()))
  with check (bucket_id = 'menu-imports' and (app.has_perm('menu.create') or app.has_perm('menu.update') or app.can_write()));

-- ── AI Inventory Import ───────────────────────────────────────────────────
-- The SAME document-to-draft pattern as AI Menu Import (spec: "AI should
-- not be designed as menu-import AI. It should become a general
-- restaurant-management action engine"), proven a second time: file (PDF
-- or CSV text) -> LLM structuring (aiDocumentEngine.ts, shared with menu
-- import) -> validation -> diff against LIVE inventory_items -> owner
-- review -> selective apply. Applying writes to the SAME inventory_items
-- table the manual Inventory page uses. Uses the generically-named
-- 'ai-imports' bucket (not 'menu-imports') since this is the first of
-- presumably several non-menu domains to land here.
create type app.inventory_import_status as enum ('draft', 'ready_for_review', 'applied', 'rejected', 'failed');

create table public.inventory_import_drafts (
  id              uuid primary key default gen_random_uuid(),
  source_filename text not null,
  storage_path    text not null,
  extracted_json  jsonb not null,
  diff_json       jsonb not null,
  status          app.inventory_import_status not null default 'ready_for_review',
  error           text,
  created_by      uuid,
  created_at      timestamptz not null default now(),
  applied_at      timestamptz,
  applied_by      uuid
);
alter table public.inventory_import_drafts enable row level security;
create policy staff_read on public.inventory_import_drafts for select using (app.has_perm('stock.view') or app.is_staff());
create policy mgr_write on public.inventory_import_drafts for all
  using (app.has_perm('stock.update') or app.can_write())
  with check (app.has_perm('stock.update') or app.can_write());

insert into storage.buckets (id, name, public)
values ('ai-imports', 'ai-imports', false)
on conflict (id) do nothing;
-- Shared by every AI import domain (inventory, recipes, tables,
-- suppliers, ...) — broadened as each one lands rather than kept
-- inventory-only, since the whole point of this bucket's generic name is
-- that one upload surface serves all of them.
create policy "ai-imports staff read" on storage.objects for select
  using (bucket_id = 'ai-imports' and (
    app.has_perm('stock.view') or app.has_perm('menu.view') or
    app.has_perm('supplier.view') or app.has_perm('tables.view') or
    app.has_perm('purchases.view') or app.has_perm('staff.view') or
    app.is_staff()
  ));
create policy "ai-imports staff write" on storage.objects for all
  using (bucket_id = 'ai-imports' and (
    app.has_perm('stock.update') or app.has_perm('inventory.manage_recipes') or
    app.has_perm('finance.manage_recipes') or app.has_perm('tables.update') or
    app.has_perm('supplier.manage') or app.has_perm('purchases.update') or
    app.has_perm('staff.create') or app.can_write()
  ))
  with check (bucket_id = 'ai-imports' and (
    app.has_perm('stock.update') or app.has_perm('inventory.manage_recipes') or
    app.has_perm('finance.manage_recipes') or app.has_perm('tables.update') or
    app.has_perm('supplier.manage') or app.has_perm('purchases.update') or
    app.has_perm('staff.create') or app.can_write()
  ));

-- ── AI Recipe Import ──────────────────────────────────────────────────────
-- Third domain on the shared engine (menu, then inventory, now recipes).
-- Creates recipes ONLY through create_recipe() — never a raw table insert
-- — so it always lands as a draft, subject to the same validation and
-- permission checks as the manual Recipes page and the AI chat's
-- draft_recipe action. Never edits an existing recipe.
create type app.recipe_import_status as enum ('draft', 'ready_for_review', 'applied', 'rejected', 'failed');
create table public.recipe_import_drafts (
  id              uuid primary key default gen_random_uuid(),
  source_filename text not null,
  storage_path    text not null,
  extracted_json  jsonb not null,
  diff_json       jsonb not null,
  status          app.recipe_import_status not null default 'ready_for_review',
  error           text,
  created_by      uuid,
  created_at      timestamptz not null default now(),
  applied_at      timestamptz,
  applied_by      uuid
);
alter table public.recipe_import_drafts enable row level security;
create policy staff_read on public.recipe_import_drafts for select
  using (app.has_perm('inventory.manage_recipes') or app.has_perm('finance.manage_recipes'));
create policy mgr_write on public.recipe_import_drafts for all
  using (app.has_perm('inventory.manage_recipes') or app.has_perm('finance.manage_recipes'))
  with check (app.has_perm('inventory.manage_recipes') or app.has_perm('finance.manage_recipes'));

-- ── AI Table Import ───────────────────────────────────────────────────────
-- Create-only — a table label that already exists is left alone rather
-- than having its seat count silently overwritten from a document.
create type app.table_import_status as enum ('draft', 'ready_for_review', 'applied', 'rejected', 'failed');
create table public.table_import_drafts (
  id              uuid primary key default gen_random_uuid(),
  source_filename text not null,
  storage_path    text not null,
  extracted_json  jsonb not null,
  diff_json       jsonb not null,
  status          app.table_import_status not null default 'ready_for_review',
  error           text,
  created_by      uuid,
  created_at      timestamptz not null default now(),
  applied_at      timestamptz,
  applied_by      uuid
);
alter table public.table_import_drafts enable row level security;
create policy staff_read on public.table_import_drafts for select using (app.has_perm('tables.view') or app.is_staff());
create policy mgr_write on public.table_import_drafts for all
  using (app.has_perm('tables.update') or app.can_write())
  with check (app.has_perm('tables.update') or app.can_write());

-- ── AI Supplier Import ────────────────────────────────────────────────────
-- Create-only — contact/payment details on an existing supplier (matched
-- by name) are never silently overwritten from a document; that's exactly
-- the kind of field a wrong overwrite could misdirect a real order or
-- payment to.
create type app.supplier_import_status as enum ('draft', 'ready_for_review', 'applied', 'rejected', 'failed');
create table public.supplier_import_drafts (
  id              uuid primary key default gen_random_uuid(),
  source_filename text not null,
  storage_path    text not null,
  extracted_json  jsonb not null,
  diff_json       jsonb not null,
  status          app.supplier_import_status not null default 'ready_for_review',
  error           text,
  created_by      uuid,
  created_at      timestamptz not null default now(),
  applied_at      timestamptz,
  applied_by      uuid
);
alter table public.supplier_import_drafts enable row level security;
create policy staff_read on public.supplier_import_drafts for select using (app.has_perm('supplier.view') or app.is_staff());
create policy mgr_write on public.supplier_import_drafts for all
  using (app.has_perm('supplier.manage') or app.can_write())
  with check (app.has_perm('supplier.manage') or app.can_write());

-- ── AI Supplier Price Import ──────────────────────────────────────────────
-- Price CHANGES on an existing (supplier, item) catalog entry go through
-- set_supplier_item_price() at apply time (logged to
-- supplier_price_history like every other price change); a brand new
-- pairing is a plain insert, matching the manual Inventory page's own
-- supplier_items insert. Never creates a supplier or an inventory item —
-- both must already exist.
create type app.supplier_price_import_status as enum ('draft', 'ready_for_review', 'applied', 'rejected', 'failed');
create table public.supplier_price_import_drafts (
  id              uuid primary key default gen_random_uuid(),
  source_filename text not null,
  storage_path    text not null,
  extracted_json  jsonb not null,
  diff_json       jsonb not null,
  status          app.supplier_price_import_status not null default 'ready_for_review',
  error           text,
  created_by      uuid,
  created_at      timestamptz not null default now(),
  applied_at      timestamptz,
  applied_by      uuid
);
alter table public.supplier_price_import_drafts enable row level security;
create policy staff_read on public.supplier_price_import_drafts for select using (app.has_perm('supplier.view') or app.is_staff());
create policy mgr_write on public.supplier_price_import_drafts for all
  using (app.has_perm('supplier.manage') or app.can_write())
  with check (app.has_perm('supplier.manage') or app.can_write());

-- ── AI Purchase Order Import ──────────────────────────────────────────────
-- Creates each order ONLY with prices already on file in that supplier's
-- own catalog (never invented) — if any line in an order doesn't resolve,
-- the WHOLE order is blocked, matching the AI chat's draft_purchase_order
-- rule. Every created order lands as a 'draft'; approving/sending stays a
-- separate, human-only step in Purchasing.
create type app.po_import_status as enum ('draft', 'ready_for_review', 'applied', 'rejected', 'failed');
create table public.po_import_drafts (
  id              uuid primary key default gen_random_uuid(),
  source_filename text not null,
  storage_path    text not null,
  extracted_json  jsonb not null,
  diff_json       jsonb not null,
  status          app.po_import_status not null default 'ready_for_review',
  error           text,
  created_by      uuid,
  created_at      timestamptz not null default now(),
  applied_at      timestamptz,
  applied_by      uuid
);
alter table public.po_import_drafts enable row level security;
create policy staff_read on public.po_import_drafts for select using (app.has_perm('purchases.view') or app.is_staff());
create policy mgr_write on public.po_import_drafts for all
  using (app.has_perm('purchases.update') or app.can_write())
  with check (app.has_perm('purchases.update') or app.can_write());

-- ── AI Staff Import ───────────────────────────────────────────────────────
-- The one import domain that creates real login credentials, so it
-- carries its own extra safeguards (see apps/api/src/lib/staffImport.ts):
-- exact role matching against the same fixed creatable-role list
-- POST /api/staff enforces (never 'owner'), and an anti-escalation check
-- identical to POST /api/staff/access — a row whose role exceeds the
-- approving user's OWN permissions is blocked, not silently capped. An
-- existing account (matched by email) is left alone.
create type app.staff_import_status as enum ('draft', 'ready_for_review', 'applied', 'rejected', 'failed');
create table public.staff_import_drafts (
  id              uuid primary key default gen_random_uuid(),
  source_filename text not null,
  storage_path    text not null,
  extracted_json  jsonb not null,
  diff_json       jsonb not null,
  status          app.staff_import_status not null default 'ready_for_review',
  error           text,
  created_by      uuid,
  created_at      timestamptz not null default now(),
  applied_at      timestamptz,
  applied_by      uuid
);
alter table public.staff_import_drafts enable row level security;
create policy staff_read on public.staff_import_drafts for select using (app.has_perm('staff.view') or app.is_staff());
create policy mgr_write on public.staff_import_drafts for all
  using (app.has_perm('staff.create') or app.can_write())
  with check (app.has_perm('staff.create') or app.can_write());

-- orders / order_lines: staff read + update (KDS, counter). Inserts via place_order().
alter table public.orders enable row level security;
create policy staff_read on public.orders for select using (app.has_perm('orders.view') or app.is_staff());
create policy staff_update on public.orders for update using (app.has_perm('orders.update') or app.is_staff()) with check (app.has_perm('orders.update') or app.is_staff());

alter table public.order_lines enable row level security;
create policy staff_read on public.order_lines for select using (app.has_perm('orders.view') or app.is_staff());
create policy staff_update on public.order_lines for update using (app.has_perm('orders.update') or app.is_staff()) with check (app.has_perm('orders.update') or app.is_staff());

alter table public.stock_ledger enable row level security;
create policy staff_read on public.stock_ledger for select using (app.has_perm('stock.view') or app.is_staff());

alter table public.order_counter enable row level security; -- functions only
alter table public.outbox enable row level security;        -- service_role only

alter table public.table_sessions enable row level security;
create policy staff_read on public.table_sessions for select using (app.has_perm('orders.view') or app.is_staff());
create policy guest_read on public.table_sessions for select using (true);

-- Guest order tracking: a customer holds the order id (an unguessable uuid) as a
-- capability, so anon may read that row and subscribe to its changes.
create policy guest_read on public.orders for select using (true);
create policy guest_read on public.order_lines for select using (true);

-- Realtime so the customer's tracking page updates with no refresh, and the
-- kitchen / cashier / waiter boards react live.
alter publication supabase_realtime add table public.orders;
alter publication supabase_realtime add table public.order_lines;

-- ── Guest feedback (no account needed) ───────────────────────────────────
create table public.feedback (
  id           uuid primary key default gen_random_uuid(),
  order_id     uuid references public.orders(id) on delete set null,
  table_label  text,
  guest_name   text,
  overall      int not null check (overall between 1 and 5),
  food         int check (food between 1 and 5),
  service      int check (service between 1 and 5),
  cleanliness  int check (cleanliness between 1 and 5),
  speed        int check (speed between 1 and 5),
  ambiance     int check (ambiance between 1 and 5),
  comment      text,
  created_at   timestamptz not null default now()
);
alter table public.feedback enable row level security;
create policy guest_insert on public.feedback for insert with check (true);
create policy staff_read on public.feedback for select using (app.has_perm('reviews.view') or app.is_staff());

-- ── Functions ────────────────────────────────────────────────────────────
-- Generic stock-ledger writer. Never lets stock go negative (spec §44 —
-- "strict stock" is the explicit, auditable policy chosen here) except
-- through an insufficient_stock rejection at order time, which is its own
-- atomic guard elsewhere. Any ledger reason is accepted; the two RPCs below
-- are thin, permission-scoped, UI-named wrappers over this same writer so a
-- stock count and a wastage entry are recorded as what they actually are
-- (spec §17-18), not both as an anonymous "adjustment".
create or replace function public.adjust_stock(
  p_inventory_item_id uuid, p_delta numeric, p_reason text, p_note text default null
) returns numeric
language plpgsql security definer set search_path = public, app as $$
declare
  v_new numeric; v_cost numeric;
  v_line record; v_open_count int;
  v_factor numeric; v_old_stock numeric; v_old_cost numeric;
  v_outstanding_base numeric; v_take_base numeric; v_take_purchase numeric;
  v_receipt_cost_per_base numeric; v_new_cost numeric; v_remaining_lines int;
  v_remaining_delta numeric := p_delta;
begin
  if not (app.has_perm('stock.adjust') or app.has_perm('inventory.manage')
          or (app.can_write() and app.current_member_role() is not null)) then
    raise exception 'forbidden' using errcode = 'insufficient_privilege';
  end if;

  -- Auto-link a manual restock to purchasing when there's exactly one
  -- unambiguous open PO line for this item ("purchasing should
  -- automatically update when we stock inventory"). Zero or multiple
  -- matches fall through to the plain path below unchanged — never guess
  -- which delivery a restock was for. Same weighted-average costing and
  -- PO-status logic as receive_purchase_order_line(), just entered from
  -- the inventory side instead of the purchasing side.
  if coalesce(nullif(p_reason,''),'adjustment') = 'restock' and p_delta > 0 then
    select count(*) into v_open_count
      from public.purchase_order_lines pol
      join public.purchase_orders po on po.id = pol.purchase_order_id
     where pol.inventory_item_id = p_inventory_item_id
       and pol.qty > pol.received_qty
       and po.status in ('sent', 'partial');

    if v_open_count = 1 then
      select pol.id, pol.purchase_order_id, pol.qty, pol.received_qty, pol.unit_cost_cents, po.po_number
        into v_line
        from public.purchase_order_lines pol
        join public.purchase_orders po on po.id = pol.purchase_order_id
       where pol.inventory_item_id = p_inventory_item_id
         and pol.qty > pol.received_qty
         and po.status in ('sent', 'partial')
       limit 1;

      select purchase_unit_to_base, stock_qty, cost_cents_per_base_unit
        into v_factor, v_old_stock, v_old_cost
        from public.inventory_items where id = p_inventory_item_id;

      v_outstanding_base := (v_line.qty - v_line.received_qty) * coalesce(v_factor, 1);
      v_take_base := least(v_remaining_delta, v_outstanding_base);

      if v_take_base > 0 then
        v_take_purchase := v_take_base / greatest(coalesce(v_factor, 1), 0.0001);
        v_receipt_cost_per_base := v_line.unit_cost_cents / greatest(coalesce(v_factor, 1), 0.0001);
        v_new_cost := case when (coalesce(v_old_stock, 0) + v_take_base) > 0
          then (coalesce(v_old_stock, 0) * coalesce(v_old_cost, 0) + v_take_base * v_receipt_cost_per_base)
               / (coalesce(v_old_stock, 0) + v_take_base)
          else coalesce(v_old_cost, 0) end;

        update public.inventory_items
           set stock_qty = stock_qty + v_take_base, cost_cents_per_base_unit = v_new_cost
         where id = p_inventory_item_id
        returning stock_qty into v_new;

        insert into public.stock_ledger (inventory_item_id, delta_qty, reason, note, unit_cost_cents_base)
        values (p_inventory_item_id, v_take_base, 'restock',
                'Auto-matched to PO #' || v_line.po_number || coalesce(' — ' || p_note, ''),
                v_receipt_cost_per_base);

        update public.purchase_order_lines set received_qty = received_qty + v_take_purchase where id = v_line.id;

        select count(*) into v_remaining_lines from public.purchase_order_lines
         where purchase_order_id = v_line.purchase_order_id and received_qty < qty;
        update public.purchase_orders
           set status = case when v_remaining_lines = 0 then 'received'::app.po_status else 'partial'::app.po_status end,
               received_at = case when v_remaining_lines = 0 then now() else received_at end
         where id = v_line.purchase_order_id;

        v_remaining_delta := v_remaining_delta - v_take_base;
        if v_remaining_delta = 0 then return v_new; end if;
      end if;
    end if;
  end if;

  select cost_cents_per_base_unit into v_cost from public.inventory_items where id = p_inventory_item_id;
  update public.inventory_items set stock_qty = stock_qty + v_remaining_delta
   where id = p_inventory_item_id returning stock_qty into v_new;
  if not found then raise exception 'inventory_item_not_found' using errcode = 'foreign_key_violation'; end if;
  if v_new < 0 then raise exception 'would_go_negative' using errcode = 'check_violation'; end if;
  insert into public.stock_ledger (inventory_item_id, delta_qty, reason, note, unit_cost_cents_base)
  values (p_inventory_item_id, v_remaining_delta, coalesce(nullif(p_reason,''),'adjustment')::app.stock_reason, p_note, v_cost);
  return v_new;
end $$;
revoke all on function public.adjust_stock(uuid, numeric, text, text) from public;
grant execute on function public.adjust_stock(uuid, numeric, text, text) to authenticated, service_role;

-- Wastage: always reason='spoilage', always requires a note (spec §17 —
-- "record: item, quantity, reason ... notes").
create or replace function public.record_ingredient_waste(
  p_inventory_item_id uuid, p_qty numeric, p_note text
) returns numeric
language plpgsql security definer set search_path = public, app as $$
declare v_new numeric; v_cost numeric;
begin
  if not (app.has_perm('inventory.manage_waste') or app.has_perm('stock.adjust') or app.can_write()) then
    raise exception 'forbidden' using errcode = 'insufficient_privilege';
  end if;
  if coalesce(p_qty, 0) <= 0 then raise exception 'bad_qty' using errcode = 'check_violation'; end if;
  if coalesce(trim(p_note), '') = '' then raise exception 'reason_required' using errcode = 'check_violation'; end if;
  select cost_cents_per_base_unit into v_cost from public.inventory_items where id = p_inventory_item_id;
  update public.inventory_items set stock_qty = stock_qty - p_qty
   where id = p_inventory_item_id and stock_qty >= p_qty
   returning stock_qty into v_new;
  if not found then raise exception 'insufficient_stock: %', p_inventory_item_id using errcode = 'check_violation'; end if;
  insert into public.stock_ledger (inventory_item_id, delta_qty, reason, note, unit_cost_cents_base)
  values (p_inventory_item_id, -p_qty, 'spoilage', p_note, v_cost);
  return v_new;
end $$;
revoke all on function public.record_ingredient_waste(uuid, numeric, text) from public;
grant execute on function public.record_ingredient_waste(uuid, numeric, text) to authenticated, service_role;

-- Stock count: staff enters the physical count; this records the variance
-- as an auditable adjustment against whatever the system currently shows,
-- never a silent overwrite (spec §19).
create or replace function public.submit_stock_count(
  p_inventory_item_id uuid, p_counted_qty numeric, p_note text default null
) returns jsonb
language plpgsql security definer set search_path = public, app as $$
declare v_before numeric; v_delta numeric; v_cost numeric;
begin
  if not (app.has_perm('stock.count') or app.has_perm('stock.adjust') or app.can_write()) then
    raise exception 'forbidden' using errcode = 'insufficient_privilege';
  end if;
  if p_counted_qty < 0 then raise exception 'bad_qty' using errcode = 'check_violation'; end if;
  select stock_qty, cost_cents_per_base_unit into v_before, v_cost from public.inventory_items where id = p_inventory_item_id;
  if not found then raise exception 'inventory_item_not_found' using errcode = 'foreign_key_violation'; end if;
  v_delta := p_counted_qty - v_before;
  update public.inventory_items set stock_qty = p_counted_qty where id = p_inventory_item_id;
  insert into public.stock_ledger (inventory_item_id, delta_qty, reason, note, unit_cost_cents_base)
  values (p_inventory_item_id, v_delta, 'stock_take', coalesce(nullif(trim(p_note), ''), 'stock count'), v_cost);
  return jsonb_build_object('before', v_before, 'counted', p_counted_qty, 'variance', v_delta);
end $$;
revoke all on function public.submit_stock_count(uuid, numeric, text) from public;
grant execute on function public.submit_stock_count(uuid, numeric, text) to authenticated, service_role;

-- Declared ahead of place_order() below, which references it in a DECLARE
-- block; plpgsql validates declared types at CREATE FUNCTION time, so the
-- type must exist before this point even though the promotions table it
-- belongs to isn't created until later (place_order only references that
-- table inside the function body, which postgres binds lazily).
create type app.promo_kind as enum ('percent', 'fixed', 'bogo');

create or replace function public.place_order(
  p_channel text, p_table_label text, p_customer_name text,
  p_tax_rate_bps integer, p_lines jsonb,
  p_discount_cents int default 0, p_promo_code text default null,
  p_customer_note text default null
) returns table (order_id uuid, order_number bigint, subtotal_cents int, discount_cents int, tax_cents int, total_cents int)
language plpgsql security definer set search_path = public, app as $$
declare
  v_order_id uuid; v_no bigint; v_sub int := 0; v_tax int; v_total int;
  v_line jsonb; v_qty int; v_lt int; v_comp record; v_need numeric; v_upd int;
  v_session_id uuid; v_disc int := greatest(0, coalesce(p_discount_cents, 0));
  v_variant_id uuid; v_item_id uuid; v_item_name text; v_variant_name text;
  v_price int; v_avail boolean; v_track boolean;
  v_deal_id uuid; v_dc record;
  v_line_id uuid; v_recipe_cost int; v_cost_per_base numeric;
  v_promo_id uuid; v_promo_kind app.promo_kind; v_val_bps int; v_val_cents int;
begin
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'no_lines' using errcode = 'check_violation';
  end if;

  update public.order_counter set next_number = next_number + 1 where id returning next_number - 1 into v_no;

  -- Attach to the table's open session; open one if there isn't a live tab.
  if coalesce(p_table_label, '') <> '' then
    select id into v_session_id from public.table_sessions
     where table_label = p_table_label and status = 'open'
     order by opened_at desc limit 1;
    if v_session_id is null then
      insert into public.table_sessions (table_label) values (p_table_label) returning id into v_session_id;
    end if;
  end if;

  insert into public.orders (order_number, session_id, channel, table_label, customer_name, status)
  values (v_no, v_session_id, coalesce(nullif(p_channel,''),'dine_in')::app.order_channel, p_table_label, p_customer_name, 'pending')
  returning id into v_order_id;

  for v_line in select value from jsonb_array_elements(p_lines) as t(value) loop
    v_qty := coalesce((v_line->>'qty')::int, 0);
    if v_qty <= 0 then raise exception 'bad_qty' using errcode = 'check_violation'; end if;

    v_deal_id := nullif(v_line->>'deal_id', '')::uuid;

    if v_deal_id is not null then
      -- ── Deal / combo: one priced HEADER line + zero-priced COMPONENT lines ──
      select d.name, d.price_cents, d.track_availability,
             (d.is_available
              and (d.starts_at is null or d.starts_at <= now())
              and (d.ends_at   is null or d.ends_at   >= now())
              and (not d.track_availability or d.available_qty >= v_qty))
        into v_item_name, v_price, v_track, v_avail
        from public.deals d where d.id = v_deal_id;
      if not found then raise exception 'deal_not_found: %', v_deal_id using errcode = 'foreign_key_violation'; end if;
      if not coalesce(v_avail, false) then
        raise exception 'deal_unavailable: %', v_item_name using errcode = 'check_violation';
      end if;

      v_lt := v_price * v_qty;
      v_sub := v_sub + v_lt;
      insert into public.order_lines
        (order_id, deal_id, name_snapshot, unit_price_cents, qty, line_total_cents, modifiers, customer_note)
      values
        (v_order_id, v_deal_id, v_item_name, v_price, v_qty, v_lt, '[]'::jsonb,
         nullif(left(coalesce(v_line->>'note', ''), 500), ''));
      -- Atomic, concurrency-safe: the WHERE re-checks available_qty at the
      -- moment of the write, not just at the SELECT above, so two orders
      -- racing for the last unit can't both succeed.
      update public.deals set available_qty = available_qty - v_qty
       where id = v_deal_id and track_availability and available_qty >= v_qty;
      get diagnostics v_upd = row_count;
      if v_track and v_upd = 0 then
        raise exception 'deal_unavailable: %', v_item_name using errcode = 'check_violation';
      end if;

      for v_dc in select menu_item_id, variant_id, qty from public.deal_components where deal_id = v_deal_id loop
        if v_dc.variant_id is not null then
          select v.id, v.menu_item_id, i.name, v.name, v.track_availability, (v.is_available and i.is_available)
            into v_variant_id, v_item_id, v_item_name, v_variant_name, v_track, v_avail
            from public.menu_variants v join public.menu_items i on i.id = v.menu_item_id
           where v.id = v_dc.variant_id;
        else
          v_item_id := v_dc.menu_item_id;
          select i.name, i.is_available into v_item_name, v_avail
            from public.menu_items i where i.id = v_item_id;
          select v.id, v.name, v.track_availability, (v.is_available and v_avail)
            into v_variant_id, v_variant_name, v_track, v_avail
            from public.menu_variants v where v.menu_item_id = v_item_id
           order by v.sort_order, v.created_at limit 1;
        end if;
        if not coalesce(v_avail, false) then
          raise exception 'deal_item_unavailable: %', coalesce(v_item_name, '?') using errcode = 'check_violation';
        end if;
        insert into public.order_lines
          (order_id, deal_id, menu_item_id, variant_id, name_snapshot, variant_name_snapshot,
           unit_price_cents, qty, line_total_cents, modifiers)
        values
          (v_order_id, v_deal_id, v_item_id, v_variant_id,
           v_item_name || case when v_variant_name is not null and v_variant_name <> 'Regular' then ' · ' || v_variant_name else '' end,
           v_variant_name, 0, v_dc.qty * v_qty, 0, '[]'::jsonb)
        returning id into v_line_id;
        if v_variant_id is not null then
          update public.menu_variants set available_qty = available_qty - v_dc.qty * v_qty
           where id = v_variant_id and track_availability and available_qty >= v_dc.qty * v_qty;
          get diagnostics v_upd = row_count;
          if v_track and v_upd = 0 then
            raise exception 'deal_item_unavailable: %', coalesce(v_item_name, '?') using errcode = 'check_violation';
          end if;
        end if;
        -- Recipe explosion, variant-aware exactly like the plain-order path
        -- below (spec §11, §13): a variant-specific recipe fully replaces
        -- the item's base recipe when the component pinned a variant that
        -- has one of its own.
        v_recipe_cost := 0;
        for v_comp in
          select inventory_item_id, qty_per_unit from public.recipe_components
           where menu_item_id = v_item_id
             and variant_id is not distinct from (
               case when exists(
                 select 1 from public.recipe_components where menu_item_id = v_item_id and variant_id = v_variant_id
               ) then v_variant_id else null end)
        loop
          v_need := v_comp.qty_per_unit * v_dc.qty * v_qty;
          select cost_cents_per_base_unit into v_cost_per_base from public.inventory_items where id = v_comp.inventory_item_id;
          v_recipe_cost := v_recipe_cost + round(v_need * coalesce(v_cost_per_base, 0));
          update public.inventory_items set stock_qty = stock_qty - v_need
           where id = v_comp.inventory_item_id and stock_qty >= v_need;
          get diagnostics v_upd = row_count;
          if v_upd = 0 then raise exception 'insufficient_stock: %', v_comp.inventory_item_id using errcode = 'check_violation'; end if;
          insert into public.stock_ledger (inventory_item_id, delta_qty, reason, order_id, unit_cost_cents_base)
          values (v_comp.inventory_item_id, -v_need, 'order_deduction', v_order_id, v_cost_per_base);
        end loop;
        update public.order_lines set recipe_cost_cents = v_recipe_cost where id = v_line_id;
      end loop;

      -- Build-Your-Own selections (spec §7-10): the client sends only
      -- deal_option_items IDs, never a price — re-priced/re-validated here
      -- exactly like item modifiers are, one group at a time (min/max
      -- enforced), before any of it can affect the total. A deal with no
      -- option groups (the plain fixed-price case) simply finds nothing to
      -- loop over here — fully backward compatible.
      declare
        v_deal_opt_ids uuid[] := array(
          select (x)::uuid from jsonb_array_elements_text(coalesce(v_line->'deal_option_ids', '[]'::jsonb)) as x
        );
        v_grp record;
        v_grp_selected int;
        v_oi record;
      begin
        for v_grp in select id, name, min_select, max_select from public.deal_option_groups where deal_id = v_deal_id loop
          select count(*) into v_grp_selected
            from public.deal_option_items doi
           where doi.group_id = v_grp.id and doi.id = any(v_deal_opt_ids);
          if v_grp_selected < v_grp.min_select then
            raise exception 'deal_option_required: %', v_grp.name using errcode = 'check_violation';
          end if;
          if v_grp.max_select is not null and v_grp_selected > v_grp.max_select then
            raise exception 'deal_option_too_many: %', v_grp.name using errcode = 'check_violation';
          end if;
        end loop;

        for v_oi in
          select doi.id, doi.menu_item_id, doi.variant_id, doi.qty, doi.price_adjustment_cents
            from public.deal_option_items doi
            join public.deal_option_groups dog on dog.id = doi.group_id
           where dog.deal_id = v_deal_id and doi.id = any(v_deal_opt_ids)
        loop
          if v_oi.variant_id is not null then
            select v.id, v.menu_item_id, i.name, v.name, v.track_availability, (v.is_available and i.is_available)
              into v_variant_id, v_item_id, v_item_name, v_variant_name, v_track, v_avail
              from public.menu_variants v join public.menu_items i on i.id = v.menu_item_id
             where v.id = v_oi.variant_id;
          else
            v_item_id := v_oi.menu_item_id;
            select i.name, i.is_available into v_item_name, v_avail
              from public.menu_items i where i.id = v_item_id;
            select v.id, v.name, v.track_availability, (v.is_available and v_avail)
              into v_variant_id, v_variant_name, v_track, v_avail
              from public.menu_variants v where v.menu_item_id = v_item_id
             order by v.sort_order, v.created_at limit 1;
          end if;
          if not coalesce(v_avail, false) then
            raise exception 'deal_item_unavailable: %', coalesce(v_item_name, '?') using errcode = 'check_violation';
          end if;

          v_lt := v_oi.price_adjustment_cents * v_oi.qty * v_qty;
          v_sub := v_sub + v_lt;
          insert into public.order_lines
            (order_id, deal_id, menu_item_id, variant_id, name_snapshot, variant_name_snapshot,
             unit_price_cents, qty, line_total_cents, modifiers)
          values
            (v_order_id, v_deal_id, v_item_id, v_variant_id,
             v_item_name || case when v_variant_name is not null and v_variant_name <> 'Regular' then ' · ' || v_variant_name else '' end,
             v_variant_name, v_oi.price_adjustment_cents, v_oi.qty * v_qty, v_lt, '[]'::jsonb)
          returning id into v_line_id;

          if v_variant_id is not null then
            update public.menu_variants set available_qty = available_qty - v_oi.qty * v_qty
             where id = v_variant_id and track_availability and available_qty >= v_oi.qty * v_qty;
            get diagnostics v_upd = row_count;
            if v_track and v_upd = 0 then
              raise exception 'deal_item_unavailable: %', coalesce(v_item_name, '?') using errcode = 'check_violation';
            end if;
          end if;

          v_recipe_cost := 0;
          for v_comp in
            select inventory_item_id, qty_per_unit from public.recipe_components
             where menu_item_id = v_item_id
               and variant_id is not distinct from (
                 case when exists(
                   select 1 from public.recipe_components where menu_item_id = v_item_id and variant_id = v_variant_id
                 ) then v_variant_id else null end)
          loop
            v_need := v_comp.qty_per_unit * v_oi.qty * v_qty;
            select cost_cents_per_base_unit into v_cost_per_base from public.inventory_items where id = v_comp.inventory_item_id;
            v_recipe_cost := v_recipe_cost + round(v_need * coalesce(v_cost_per_base, 0));
            update public.inventory_items set stock_qty = stock_qty - v_need
             where id = v_comp.inventory_item_id and stock_qty >= v_need;
            get diagnostics v_upd = row_count;
            if v_upd = 0 then raise exception 'insufficient_stock: %', v_comp.inventory_item_id using errcode = 'check_violation'; end if;
            insert into public.stock_ledger (inventory_item_id, delta_qty, reason, order_id, unit_cost_cents_base)
            values (v_comp.inventory_item_id, -v_need, 'order_deduction', v_order_id, v_cost_per_base);
          end loop;
          update public.order_lines set recipe_cost_cents = v_recipe_cost where id = v_line_id;
        end loop;
      end;

    else
    v_variant_id := nullif(v_line->>'variant_id', '')::uuid;
    if v_variant_id is not null then
      -- Explicit variant: price + availability come from the variant.
      select v.id, v.menu_item_id, i.name, v.name, v.price_cents, v.track_availability, (v.is_available and i.is_available)
        into v_variant_id, v_item_id, v_item_name, v_variant_name, v_price, v_track, v_avail
        from public.menu_variants v join public.menu_items i on i.id = v.menu_item_id
       where v.id = v_variant_id;
      if not found then raise exception 'variant_not_found: %', v_line->>'variant_id' using errcode = 'foreign_key_violation'; end if;
    else
      -- Legacy line: item id only. Use its default (first) variant if one exists.
      v_item_id := (v_line->>'menu_item_id')::uuid;
      select i.name, i.is_available, i.price_cents into v_item_name, v_avail, v_price
        from public.menu_items i where i.id = v_item_id;
      if not found then raise exception 'menu_item_not_found: %', v_line->>'menu_item_id' using errcode = 'foreign_key_violation'; end if;
      select v.id, v.name, v.price_cents, v.track_availability, (v.is_available and v_avail)
        into v_variant_id, v_variant_name, v_price, v_track, v_avail
        from public.menu_variants v where v.menu_item_id = v_item_id
       order by v.sort_order, v.created_at limit 1;
    end if;

    if not coalesce(v_avail, false) then
      raise exception 'item_unavailable: %', coalesce(v_item_name, v_item_id::text) using errcode = 'check_violation';
    end if;

    -- Modifiers: the client sends only option IDs, never a price or name.
    -- Every option is re-priced and re-validated here — belongs to this
    -- item, currently available, and each group's required/min/max is
    -- satisfied — before it can affect the total. Unknown or stale IDs are
    -- silently dropped rather than trusted.
    declare
      v_mod_ids uuid[] := array(
        select (x)::uuid from jsonb_array_elements_text(coalesce(v_line->'modifier_option_ids', '[]'::jsonb)) as x
      );
      v_mod_total int;
      v_mod_snapshot jsonb;
      v_valid_mod_ids uuid[];
      v_grp record;
      v_grp_selected int;
      v_has_variant_recipe boolean;
    begin
      select coalesce(sum(mo.price_cents), 0),
             coalesce(jsonb_agg(jsonb_build_object('id', mo.id, 'name', mo.name, 'price_cents', mo.price_cents)
                                 order by mo.sort_order), '[]'::jsonb),
             coalesce(array_agg(mo.id), '{}')
        into v_mod_total, v_mod_snapshot, v_valid_mod_ids
        from public.modifier_options mo
        join public.modifier_groups mg on mg.id = mo.group_id
       where mo.id = any(v_mod_ids) and mo.is_available and mg.menu_item_id = v_item_id;

      for v_grp in select id, name, kind, min_select, max_select
                     from public.modifier_groups where menu_item_id = v_item_id loop
        select count(*) into v_grp_selected
          from public.modifier_options mo
         where mo.group_id = v_grp.id and mo.id = any(v_mod_ids) and mo.is_available;
        if v_grp_selected < v_grp.min_select then
          raise exception 'modifier_required: %', v_grp.name using errcode = 'check_violation';
        end if;
        if v_grp.max_select is not null and v_grp_selected > v_grp.max_select then
          raise exception 'modifier_too_many: %', v_grp.name using errcode = 'check_violation';
        end if;
      end loop;

      v_lt := (v_price + v_mod_total) * v_qty;
      v_sub := v_sub + v_lt;

      insert into public.order_lines
        (order_id, menu_item_id, variant_id, name_snapshot, variant_name_snapshot,
         unit_price_cents, qty, line_total_cents, modifiers, customer_note)
      values
        (v_order_id, v_item_id, v_variant_id,
         v_item_name || case when v_variant_name is not null and v_variant_name <> 'Regular' then ' · ' || v_variant_name else '' end,
         v_variant_name, v_price + v_mod_total, v_qty, v_lt, v_mod_snapshot,
         nullif(left(coalesce(v_line->>'note', ''), 500), ''))
      returning id into v_line_id;

      -- Recipe explosion (spec §9-11): a recipe row scoped to THIS variant
      -- fully replaces the item's base recipe when one exists; otherwise the
      -- base recipe (variant_id is null) applies. Never both, never a naive
      -- "same recipe regardless of size" assumption.
      v_recipe_cost := 0;
      select exists(
        select 1 from public.recipe_components where menu_item_id = v_item_id and variant_id = v_variant_id
      ) into v_has_variant_recipe;
      for v_comp in
        select inventory_item_id, qty_per_unit from public.recipe_components
         where menu_item_id = v_item_id
           and variant_id is not distinct from (case when v_has_variant_recipe then v_variant_id else null end)
      loop
        v_need := v_comp.qty_per_unit * v_qty;
        select cost_cents_per_base_unit into v_cost_per_base from public.inventory_items where id = v_comp.inventory_item_id;
        v_recipe_cost := v_recipe_cost + round(v_need * coalesce(v_cost_per_base, 0));
        update public.inventory_items set stock_qty = stock_qty - v_need
         where id = v_comp.inventory_item_id and stock_qty >= v_need;
        get diagnostics v_upd = row_count;
        if v_upd = 0 then raise exception 'insufficient_stock: %', v_comp.inventory_item_id using errcode = 'check_violation'; end if;
        insert into public.stock_ledger (inventory_item_id, delta_qty, reason, order_id, unit_cost_cents_base)
        values (v_comp.inventory_item_id, -v_need, 'order_deduction', v_order_id, v_cost_per_base);
      end loop;

      -- Modifier-linked consumption (spec §12): e.g. Extra Cheese consumes
      -- one more cheese slice, Extra Patty another 150g of chicken — on top
      -- of, not instead of, the base/variant recipe above.
      for v_comp in
        select inventory_item_id, sum(qty_base) as qty_per_unit
          from public.modifier_recipe_components
         where modifier_option_id = any(v_valid_mod_ids)
         group by inventory_item_id
      loop
        v_need := v_comp.qty_per_unit * v_qty;
        select cost_cents_per_base_unit into v_cost_per_base from public.inventory_items where id = v_comp.inventory_item_id;
        v_recipe_cost := v_recipe_cost + round(v_need * coalesce(v_cost_per_base, 0));
        update public.inventory_items set stock_qty = stock_qty - v_need
         where id = v_comp.inventory_item_id and stock_qty >= v_need;
        get diagnostics v_upd = row_count;
        if v_upd = 0 then raise exception 'insufficient_stock: %', v_comp.inventory_item_id using errcode = 'check_violation'; end if;
        insert into public.stock_ledger (inventory_item_id, delta_qty, reason, order_id, unit_cost_cents_base)
        values (v_comp.inventory_item_id, -v_need, 'order_deduction', v_order_id, v_cost_per_base);
      end loop;

      update public.order_lines set recipe_cost_cents = v_recipe_cost where id = v_line_id;
    end;

    -- Variant availability counter — atomic, concurrency-safe (see the deal
    -- branch above for why: re-checks available_qty at write time, not just
    -- at the SELECT above, so two orders racing for the last unit can't both win).
    if v_variant_id is not null then
      update public.menu_variants
         set available_qty = available_qty - v_qty
       where id = v_variant_id and track_availability and available_qty >= v_qty;
      get diagnostics v_upd = row_count;
      if v_track and v_upd = 0 then
        raise exception 'item_unavailable: %', coalesce(v_item_name, v_item_id::text) using errcode = 'check_violation';
      end if;
    end if;
    end if;
  end loop;

  -- A promo code, if supplied and valid, decides the discount (staff-applied
  -- p_discount_cents is the fallback for manual till discounts). Resolved
  -- ONCE here (not via promo_discount(), which only knows percent/fixed
  -- and can't see this order's own lines) via app.promotion_is_valid_now()
  -- so this and the storefront's live preview can never disagree about
  -- whether a code is currently valid. BOGO needs the actual line items
  -- just inserted above — that's why this runs after the line loop, not
  -- before it. Redeeming — bumping usage_count and logging
  -- promotion_redemptions — happens HERE, and the usage_count bump is
  -- itself the concurrency guard: two orders racing for the last
  -- redemption of a capped code can't both win, same atomic
  -- update-with-a-still-true-where-clause pattern as deal/variant
  -- availability above.
  if coalesce(p_promo_code, '') <> '' then
    v_promo_id := null;
    select p.id, p.kind, p.value_bps, p.value_cents
      into v_promo_id, v_promo_kind, v_val_bps, v_val_cents
      from public.promotions p
     where lower(p.code) = lower(p_promo_code) and app.promotion_is_valid_now(p, v_sub)
     limit 1;
    if v_promo_id is not null then
      v_disc := case
        when v_promo_kind = 'bogo' then public.bogo_discount_for_order(v_order_id, v_promo_id)
        when v_promo_kind = 'percent' then (v_sub * coalesce(v_val_bps, 0) / 10000)
        else least(coalesce(v_val_cents, 0), v_sub)
      end;
      if v_disc > 0 then
        update public.promotions set usage_count = usage_count + 1
         where id = v_promo_id and (usage_limit_total is null or usage_count < usage_limit_total)
        returning id into v_promo_id;
        if v_promo_id is null then
          v_disc := 0; -- lost the race against the usage cap between validation and now
        else
          insert into public.promotion_redemptions (promotion_id, order_id, discount_cents)
          values (v_promo_id, v_order_id, v_disc);
        end if;
      else
        v_promo_id := null;
      end if;
    end if;
  end if;

  -- Auto-apply (spec: automatic happy-hour/time-based discounts that need
  -- no code): if nothing above already discounted this order — no code
  -- entered, or the one entered didn't validate — try the single best
  -- currently-eligible auto_apply promotion instead. A manual staff
  -- discount (p_discount_cents, already in v_disc at this point if no
  -- code path fired) still takes precedence, same as an explicit code.
  if v_disc = 0 then
    select ap.id, ap.discount_cents into v_promo_id, v_disc from public.best_auto_promotion(v_sub) ap;
    if v_promo_id is not null and v_disc > 0 then
      update public.promotions set usage_count = usage_count + 1
       where id = v_promo_id and (usage_limit_total is null or usage_count < usage_limit_total)
      returning id into v_promo_id;
      if v_promo_id is null then
        v_disc := 0; -- lost the race against the usage cap between validation and now
      else
        insert into public.promotion_redemptions (promotion_id, order_id, discount_cents)
        values (v_promo_id, v_order_id, v_disc);
      end if;
    else
      v_disc := 0;
    end if;
  end if;
  v_disc := least(greatest(v_disc, 0), v_sub);
  v_tax := round((v_sub - v_disc)::numeric * coalesce(p_tax_rate_bps,0) / 10000)::int;
  v_total := v_sub - v_disc + v_tax;
  -- promo_code on the order shows whichever code actually produced the
  -- discount (the typed one, or an auto_apply promo's own code if that's
  -- what fired) — falling back to the raw typed text so an invalid code
  -- the customer entered is still recorded even though it discounted nothing.
  update public.orders set subtotal_cents = v_sub, discount_cents = v_disc,
    promo_code = case
      when v_disc > 0 and v_promo_id is not null then (select code from public.promotions where id = v_promo_id)
      else nullif(p_promo_code, '')
    end,
    tax_cents = v_tax, total_cents = v_total, tax_rate_bps = coalesce(p_tax_rate_bps, 0),
    customer_note = nullif(left(coalesce(p_customer_note, ''), 500), ''),
    status = 'in_kitchen', updated_at = now() where id = v_order_id;

  insert into public.outbox (topic, payload) values ('order.placed', jsonb_build_object(
    'order_id', v_order_id, 'order_number', v_no, 'total_cents', v_total, 'table_label', p_table_label));

  return query select v_order_id, v_no, v_sub, v_disc, v_tax, v_total;
end $$;
revoke all on function public.place_order(text, text, text, integer, jsonb, int, text, text) from public;
grant execute on function public.place_order(text, text, text, integer, jsonb, int, text, text) to authenticated, service_role, anon;

-- Close a table's session and mark all its unpaid orders paid in one step.
create or replace function public.close_session(p_session_id uuid, p_payment_method text)
returns void
language plpgsql security definer set search_path = public, app as $fn$
begin
  update public.orders
     set status = 'paid',
         payment_method = coalesce(nullif(p_payment_method, ''), 'cash'),
         paid_at = now(),
         updated_at = now()
   where session_id = p_session_id and status <> 'void' and paid_at is null;
  update public.table_sessions set status = 'closed', closed_at = now()
   where id = p_session_id and status = 'open';
end $fn$;
revoke all on function public.close_session(uuid, text) from public;
grant execute on function public.close_session(uuid, text) to authenticated, service_role;

-- ── Payments, refunds & sensitive order actions (P4) ─────────────────────
create table public.payments (
  id             uuid primary key default gen_random_uuid(),
  order_id       uuid references public.orders(id) on delete set null,
  amount_cents   int not null check (amount_cents > 0),
  method         text not null default 'cash',
  reference      text,
  tendered_cents int,
  change_cents   int,
  refunded_cents int not null default 0 check (refunded_cents >= 0),
  status         text not null default 'captured'
                 check (status in ('captured','partially_refunded','refunded','voided')),
  captured_by    uuid,
  portal_id      uuid,
  note           text,
  created_at     timestamptz not null default now()
);
create index payments_order_idx on public.payments(order_id);

create table public.refunds (
  id           uuid primary key default gen_random_uuid(),
  payment_id   uuid references public.payments(id) on delete set null,
  order_id     uuid references public.orders(id) on delete set null,
  amount_cents int not null check (amount_cents > 0),
  reason       text not null,
  method       text,
  reference    text,
  requested_by uuid,
  approved_by  uuid,
  portal_id    uuid,
  created_at   timestamptz not null default now()
);
create index refunds_order_idx on public.refunds(order_id);

create table public.order_adjustments (
  id              uuid primary key default gen_random_uuid(),
  order_id        uuid references public.orders(id) on delete cascade,
  line_id         uuid,
  kind            text not null check (kind in ('discount','price_override','void','reopen','comp')),
  old_value_cents int,
  new_value_cents int,
  reason          text,
  actor_id        uuid,
  portal_id       uuid,
  created_at      timestamptz not null default now()
);
create index order_adjustments_order_idx on public.order_adjustments(order_id, created_at desc);

alter table public.payments enable row level security;
alter table public.refunds enable row level security;
alter table public.order_adjustments enable row level security;
-- Financial read — deliberately NOT "or app.is_staff()" (unlike most
-- tables here): payment/refund amounts are exactly the kind of data a
-- manager should only see when explicitly granted payments.view, per
-- the Owner's Portal & Access Control configuration. Every other
-- read/write policy in this file keeps its existing is_staff()/
-- can_write() fallback untouched — this is a deliberately narrow,
-- named exception for the finance domain, not a schema-wide change.
create policy staff_read on public.payments for select using (app.has_perm('payments.view'));
create policy staff_read on public.refunds for select using (app.has_perm('payments.view'));
create policy staff_read on public.order_adjustments for select using (app.has_perm('orders.view') or app.is_staff());
alter publication supabase_realtime add table public.payments;

create or replace function app.recalc_order_totals(p_order_id uuid) returns void
language plpgsql set search_path = public, app as $fn$
declare v_sub int; v_disc int; v_rate int; v_tax int;
begin
  select coalesce(sum(line_total_cents), 0) into v_sub
    from public.order_lines where order_id = p_order_id;
  select greatest(0, coalesce(discount_cents, 0)), coalesce(tax_rate_bps, 0)
    into v_disc, v_rate from public.orders where id = p_order_id;
  v_disc := least(v_disc, v_sub);
  v_tax  := round((v_sub - v_disc)::numeric * v_rate / 10000)::int;
  update public.orders
     set subtotal_cents = v_sub, discount_cents = v_disc,
         tax_cents = v_tax, total_cents = v_sub - v_disc + v_tax, updated_at = now()
   where id = p_order_id;
end $fn$;

create or replace function public.record_payment(
  p_order_id uuid, p_amount_cents int, p_method text default 'cash',
  p_tendered_cents int default null, p_reference text default null
) returns public.payments
language plpgsql security definer set search_path = public, app as $fn$
declare v_order public.orders; v_pay public.payments; v_paid int; v_due int;
begin
  if not app.has_perm('payments.accept') then
    raise exception 'forbidden' using errcode = 'insufficient_privilege';
  end if;
  if coalesce(p_amount_cents, 0) <= 0 then
    raise exception 'bad_amount' using errcode = 'check_violation';
  end if;
  select * into v_order from public.orders where id = p_order_id;
  if not found then raise exception 'order_not_found' using errcode = 'no_data_found'; end if;
  if v_order.status = 'void' then raise exception 'order_void' using errcode = 'check_violation'; end if;

  insert into public.payments
    (order_id, amount_cents, method, reference, tendered_cents, change_cents, captured_by, portal_id)
  values
    (p_order_id, p_amount_cents, coalesce(nullif(p_method, ''), 'cash'), nullif(p_reference, ''),
     p_tendered_cents,
     case when p_tendered_cents is not null then greatest(0, p_tendered_cents - p_amount_cents) end,
     app.jwt_sub(), app.current_portal_id())
  returning * into v_pay;

  select coalesce(sum(amount_cents - refunded_cents), 0) into v_paid
    from public.payments where order_id = p_order_id and status <> 'voided';
  v_due := v_order.total_cents - coalesce(v_order.refunded_cents, 0);
  if v_paid >= v_due then
    update public.orders
       set status = 'paid', paid_at = coalesce(paid_at, now()),
           payment_method = coalesce(nullif(p_method, ''), 'cash'), updated_at = now()
     where id = p_order_id;
  end if;
  return v_pay;
end $fn$;
revoke all on function public.record_payment(uuid, int, text, int, text) from public;
grant execute on function public.record_payment(uuid, int, text, int, text) to authenticated, service_role;

create or replace function public.refund_payment(
  p_payment_id uuid, p_amount_cents int, p_reason text, p_method text default null
) returns public.refunds
language plpgsql security definer set search_path = public, app as $fn$
declare v_pay public.payments; v_ref public.refunds; v_remaining int; v_threshold int;
begin
  if not app.has_perm('payments.refund') then
    raise exception 'forbidden' using errcode = 'insufficient_privilege';
  end if;
  if coalesce(trim(p_reason), '') = '' then
    raise exception 'reason_required' using errcode = 'check_violation';
  end if;
  select * into v_pay from public.payments where id = p_payment_id;
  if not found then raise exception 'payment_not_found' using errcode = 'no_data_found'; end if;
  v_remaining := v_pay.amount_cents - v_pay.refunded_cents;
  if coalesce(p_amount_cents, 0) <= 0 or p_amount_cents > v_remaining then
    raise exception 'bad_refund_amount: max %', v_remaining using errcode = 'check_violation';
  end if;

  -- Configurable amount-tiered approval (spec §6/§18): a restaurant that
  -- has set max_refund_without_approval_cents requires payments.approve_refund
  -- (or full can_write()) for anything over it — enforced here, not only
  -- by whether the UI happens to show an Approve button.
  select max_refund_without_approval_cents into v_threshold from public.business_settings where id;
  if v_threshold is not null and p_amount_cents > v_threshold
     and not (app.has_perm('payments.approve_refund') or app.can_write()) then
    raise exception 'refund_needs_approval: max % without manager approval', v_threshold
      using errcode = 'insufficient_privilege';
  end if;

  insert into public.refunds
    (payment_id, order_id, amount_cents, reason, method, requested_by, approved_by, portal_id)
  values
    (p_payment_id, v_pay.order_id, p_amount_cents, trim(p_reason),
     coalesce(nullif(p_method, ''), v_pay.method), app.jwt_sub(),
     -- Only recorded when an approval threshold actually applied and this
     -- caller's own approve permission is what let it through — a refund
     -- under the threshold (or when none is configured) needed no
     -- approval decision, so approved_by stays null for it.
     case when v_threshold is not null and p_amount_cents > v_threshold then app.jwt_sub() else null end,
     app.current_portal_id())
  returning * into v_ref;

  update public.payments
     set refunded_cents = refunded_cents + p_amount_cents,
         status = case when refunded_cents + p_amount_cents >= amount_cents
                       then 'refunded' else 'partially_refunded' end
   where id = p_payment_id;

  if v_pay.order_id is not null then
    update public.orders
       set refunded_cents = coalesce(refunded_cents, 0) + p_amount_cents, updated_at = now()
     where id = v_pay.order_id;
  end if;
  return v_ref;
end $fn$;
revoke all on function public.refund_payment(uuid, int, text, text) from public;
grant execute on function public.refund_payment(uuid, int, text, text) to authenticated, service_role;

create or replace function public.void_payment(p_payment_id uuid, p_reason text)
returns void language plpgsql security definer set search_path = public, app as $fn$
declare v_pay public.payments; v_left int;
begin
  if not app.has_perm('payments.void') then
    raise exception 'forbidden' using errcode = 'insufficient_privilege';
  end if;
  select * into v_pay from public.payments where id = p_payment_id;
  if not found then raise exception 'payment_not_found' using errcode = 'no_data_found'; end if;
  if v_pay.refunded_cents > 0 then
    raise exception 'cannot_void_refunded' using errcode = 'check_violation';
  end if;
  update public.payments set status = 'voided' where id = p_payment_id;
  insert into public.order_adjustments
    (order_id, kind, old_value_cents, new_value_cents, reason, actor_id, portal_id)
  values
    (v_pay.order_id, 'void', v_pay.amount_cents, 0,
     coalesce(nullif(trim(p_reason), ''), 'payment voided'), app.jwt_sub(), app.current_portal_id());

  if v_pay.order_id is not null then
    select coalesce(sum(amount_cents - refunded_cents), 0) into v_left
      from public.payments where order_id = v_pay.order_id and status <> 'voided';
    if v_left <= 0 then
      update public.orders set status = 'served', paid_at = null, updated_at = now()
       where id = v_pay.order_id and status = 'paid';
    end if;
  end if;
end $fn$;
revoke all on function public.void_payment(uuid, text) from public;
grant execute on function public.void_payment(uuid, text) to authenticated, service_role;

create or replace function public.cancel_order(p_order_id uuid, p_reason text)
returns void language plpgsql security definer set search_path = public, app as $fn$
declare v_status app.order_status;
begin
  if not app.has_perm('orders.cancel') then
    raise exception 'forbidden' using errcode = 'insufficient_privilege';
  end if;
  select status into v_status from public.orders where id = p_order_id;
  if not found then raise exception 'order_not_found' using errcode = 'no_data_found'; end if;
  if v_status = 'void' then return; end if;
  if v_status = 'paid' then
    raise exception 'refund_before_cancel' using errcode = 'check_violation';
  end if;
  update public.orders set status = 'void', updated_at = now() where id = p_order_id;
  insert into public.order_adjustments (order_id, kind, reason, actor_id, portal_id)
  values (p_order_id, 'void', coalesce(nullif(trim(p_reason), ''), 'cancelled'),
          app.jwt_sub(), app.current_portal_id());
end $fn$;
revoke all on function public.cancel_order(uuid, text) from public;
grant execute on function public.cancel_order(uuid, text) to authenticated, service_role;

create or replace function public.apply_order_discount(p_order_id uuid, p_discount_cents int, p_reason text)
returns void language plpgsql security definer set search_path = public, app as $fn$
declare v_old int;
begin
  if not app.has_perm('orders.apply_discount') then
    raise exception 'forbidden' using errcode = 'insufficient_privilege';
  end if;
  select coalesce(discount_cents, 0) into v_old from public.orders where id = p_order_id;
  if not found then raise exception 'order_not_found' using errcode = 'no_data_found'; end if;
  update public.orders set discount_cents = greatest(0, coalesce(p_discount_cents, 0)) where id = p_order_id;
  perform app.recalc_order_totals(p_order_id);
  insert into public.order_adjustments
    (order_id, kind, old_value_cents, new_value_cents, reason, actor_id, portal_id)
  values (p_order_id, 'discount', v_old, greatest(0, coalesce(p_discount_cents, 0)),
          coalesce(nullif(trim(p_reason), ''), 'discount'), app.jwt_sub(), app.current_portal_id());
end $fn$;
revoke all on function public.apply_order_discount(uuid, int, text) from public;
grant execute on function public.apply_order_discount(uuid, int, text) to authenticated, service_role;

create or replace function public.override_line_price(p_line_id uuid, p_unit_price_cents int, p_reason text)
returns void language plpgsql security definer set search_path = public, app as $fn$
declare v_line public.order_lines;
begin
  if not app.has_perm('orders.override_price') then
    raise exception 'forbidden' using errcode = 'insufficient_privilege';
  end if;
  if coalesce(p_unit_price_cents, -1) < 0 then
    raise exception 'bad_price' using errcode = 'check_violation';
  end if;
  select * into v_line from public.order_lines where id = p_line_id;
  if not found then raise exception 'line_not_found' using errcode = 'no_data_found'; end if;
  update public.order_lines
     set unit_price_cents = p_unit_price_cents, line_total_cents = p_unit_price_cents * qty
   where id = p_line_id;
  perform app.recalc_order_totals(v_line.order_id);
  insert into public.order_adjustments
    (order_id, line_id, kind, old_value_cents, new_value_cents, reason, actor_id, portal_id)
  values (v_line.order_id, p_line_id, 'price_override', v_line.unit_price_cents, p_unit_price_cents,
          coalesce(nullif(trim(p_reason), ''), 'price override'), app.jwt_sub(), app.current_portal_id());
end $fn$;
revoke all on function public.override_line_price(uuid, int, text) from public;
grant execute on function public.override_line_price(uuid, int, text) to authenticated, service_role;

create or replace function public.reopen_order(p_order_id uuid, p_reason text)
returns void language plpgsql security definer set search_path = public, app as $fn$
declare v_status app.order_status;
begin
  if not app.has_perm('orders.reopen') then
    raise exception 'forbidden' using errcode = 'insufficient_privilege';
  end if;
  select status into v_status from public.orders where id = p_order_id;
  if not found then raise exception 'order_not_found' using errcode = 'no_data_found'; end if;
  if v_status not in ('served', 'paid') then return; end if;
  update public.orders
     set status = 'ready', paid_at = case when v_status = 'paid' then null else paid_at end,
         updated_at = now()
   where id = p_order_id;
  insert into public.order_adjustments (order_id, kind, reason, actor_id, portal_id)
  values (p_order_id, 'reopen', coalesce(nullif(trim(p_reason), ''), 'reopened'),
          app.jwt_sub(), app.current_portal_id());
end $fn$;
revoke all on function public.reopen_order(uuid, text) from public;
grant execute on function public.reopen_order(uuid, text) to authenticated, service_role;

-- ── Kitchen Portal (P5) ─────────────────────────────────────────────────
create or replace function public.kitchen_start_order(p_order_id uuid)
returns void language plpgsql security definer set search_path = public, app as $fn$
declare v_status app.order_status;
begin
  if not app.has_perm('kitchen.update_status') then
    raise exception 'forbidden' using errcode = 'insufficient_privilege';
  end if;
  select status into v_status from public.orders where id = p_order_id;
  if not found then raise exception 'order_not_found' using errcode = 'no_data_found'; end if;
  if v_status in ('void', 'paid', 'served') then
    raise exception 'order_not_active' using errcode = 'check_violation';
  end if;
  update public.order_lines set kds_status = 'preparing'
   where order_id = p_order_id and kds_status = 'queued';
  update public.orders set status = 'in_kitchen', updated_at = now()
   where id = p_order_id and status = 'pending';
  perform app.log_action('kitchen.start', 'orders', p_order_id::text);
end $fn$;
revoke all on function public.kitchen_start_order(uuid) from public;
grant execute on function public.kitchen_start_order(uuid) to authenticated, service_role;

create or replace function public.kitchen_mark_ready(p_order_id uuid)
returns void language plpgsql security definer set search_path = public, app as $fn$
declare v_status app.order_status;
begin
  if not app.has_perm('kitchen.update_status') then
    raise exception 'forbidden' using errcode = 'insufficient_privilege';
  end if;
  select status into v_status from public.orders where id = p_order_id;
  if not found then raise exception 'order_not_found' using errcode = 'no_data_found'; end if;
  if v_status in ('void', 'paid', 'served') then
    raise exception 'order_not_active' using errcode = 'check_violation';
  end if;
  update public.order_lines set kds_status = 'ready'
   where order_id = p_order_id and kds_status <> 'served';
  update public.orders set status = 'ready', updated_at = now() where id = p_order_id;
  perform app.log_action('kitchen.ready', 'orders', p_order_id::text);
end $fn$;
revoke all on function public.kitchen_mark_ready(uuid) from public;
grant execute on function public.kitchen_mark_ready(uuid) to authenticated, service_role;

-- Kitchen picks which counter this order goes to (e.g. Counter 1 vs Counter
-- 2) — the assignment the customer's tracking page then shows by name
-- instead of listing every active checkout counter.
create or replace function public.kitchen_set_pickup_counter(p_order_id uuid, p_portal_id uuid)
returns void language plpgsql security definer set search_path = public, app as $fn$
begin
  if not app.has_perm('kitchen.update_status') then
    raise exception 'forbidden' using errcode = 'insufficient_privilege';
  end if;
  if not exists (
    select 1 from public.portals where id = p_portal_id and type = 'checkout' and status = 'active'
  ) then
    raise exception 'invalid_counter' using errcode = 'check_violation';
  end if;
  update public.orders set pickup_counter_portal_id = p_portal_id, updated_at = now()
   where id = p_order_id;
  if not found then raise exception 'order_not_found' using errcode = 'no_data_found'; end if;
  perform app.log_action('kitchen.pickup_counter', 'orders', p_order_id::text, null, jsonb_build_object('portal_id', p_portal_id));
end $fn$;
revoke all on function public.kitchen_set_pickup_counter(uuid, uuid) from public;
grant execute on function public.kitchen_set_pickup_counter(uuid, uuid) to authenticated, service_role;

create or replace function public.kitchen_complete_order(p_order_id uuid)
returns void language plpgsql security definer set search_path = public, app as $fn$
declare v_status app.order_status;
begin
  if not app.has_perm('kitchen.update_status') then
    raise exception 'forbidden' using errcode = 'insufficient_privilege';
  end if;
  select status into v_status from public.orders where id = p_order_id;
  if not found then raise exception 'order_not_found' using errcode = 'no_data_found'; end if;
  if v_status in ('void', 'paid') then
    raise exception 'order_not_active' using errcode = 'check_violation';
  end if;
  update public.order_lines set kds_status = 'served'
   where order_id = p_order_id and kds_status <> 'served';
  update public.orders set status = 'served', updated_at = now()
   where id = p_order_id and status <> 'served';
  perform app.log_action('kitchen.complete', 'orders', p_order_id::text);
end $fn$;
revoke all on function public.kitchen_complete_order(uuid) from public;
grant execute on function public.kitchen_complete_order(uuid) to authenticated, service_role;

create or replace function public.kitchen_set_line_status(p_line_id uuid, p_status text)
returns void language plpgsql security definer set search_path = public, app as $fn$
declare v_order uuid; v_all boolean;
begin
  if not app.has_perm('kitchen.update_status') then
    raise exception 'forbidden' using errcode = 'insufficient_privilege';
  end if;
  if p_status not in ('queued', 'preparing', 'ready', 'served') then
    raise exception 'bad_status' using errcode = 'check_violation';
  end if;
  update public.order_lines set kds_status = p_status::app.line_status
   where id = p_line_id returning order_id into v_order;
  if v_order is null then raise exception 'line_not_found' using errcode = 'no_data_found'; end if;

  select bool_and(kds_status in ('ready', 'served')) into v_all
    from public.order_lines where order_id = v_order;
  if v_all then
    update public.orders set status = 'ready', updated_at = now()
     where id = v_order and status not in ('served', 'paid', 'void');
  end if;
  perform app.log_action('kitchen.line_status', 'order_lines', p_line_id::text,
                         null, jsonb_build_object('kds_status', p_status));
end $fn$;
revoke all on function public.kitchen_set_line_status(uuid, text) from public;
grant execute on function public.kitchen_set_line_status(uuid, text) to authenticated, service_role;

create table public.food_stock_log (
  id         uuid primary key default gen_random_uuid(),
  variant_id uuid references public.menu_variants(id) on delete cascade,
  delta      int,
  new_qty    int,
  reason     text not null check (reason in
             ('waste','prepared','recount','closing','out_of_stock','restock')),
  actor_id   uuid,
  portal_id  uuid,
  note       text,
  created_at timestamptz not null default now()
);
create index food_stock_log_variant_idx on public.food_stock_log(variant_id, created_at desc);
alter table public.food_stock_log enable row level security;
create policy staff_read on public.food_stock_log for select using (app.has_perm('stock.view') or app.is_staff());

create or replace function public.set_food_stock(
  p_variant_id uuid, p_new_qty int, p_reason text, p_note text default null
) returns void language plpgsql security definer set search_path = public, app as $fn$
declare v_old int;
begin
  if not (app.has_perm('kitchen.manage_availability') or app.has_perm('stock.update')) then
    raise exception 'forbidden' using errcode = 'insufficient_privilege';
  end if;
  if coalesce(p_new_qty, -1) < 0 then raise exception 'bad_qty' using errcode = 'check_violation'; end if;
  if coalesce(p_reason, '') not in ('recount','prepared','closing','restock','out_of_stock') then
    raise exception 'bad_reason' using errcode = 'check_violation';
  end if;
  select available_qty into v_old from public.menu_variants where id = p_variant_id;
  if not found then raise exception 'variant_not_found' using errcode = 'no_data_found'; end if;

  update public.menu_variants
     set available_qty = p_new_qty,
         track_availability = true,
         is_available = case when p_reason = 'out_of_stock' or p_new_qty = 0 then false else true end
   where id = p_variant_id;

  insert into public.food_stock_log (variant_id, delta, new_qty, reason, actor_id, portal_id, note)
  values (p_variant_id, p_new_qty - v_old, p_new_qty, p_reason, app.jwt_sub(), app.current_portal_id(), p_note);
  perform app.log_action('kitchen.set_stock', 'menu_variants', p_variant_id::text,
                         jsonb_build_object('available_qty', v_old),
                         jsonb_build_object('available_qty', p_new_qty, 'reason', p_reason));
end $fn$;
revoke all on function public.set_food_stock(uuid, int, text, text) from public;
grant execute on function public.set_food_stock(uuid, int, text, text) to authenticated, service_role;

create or replace function public.set_variant_available(
  p_variant_id uuid, p_available boolean, p_reason text default null
) returns void language plpgsql security definer set search_path = public, app as $fn$
begin
  if not (app.has_perm('kitchen.manage_availability') or app.has_perm('availability.update')
          or app.has_perm('menu.update')) then
    raise exception 'forbidden' using errcode = 'insufficient_privilege';
  end if;
  update public.menu_variants set is_available = p_available where id = p_variant_id;
  if not found then raise exception 'variant_not_found' using errcode = 'no_data_found'; end if;
  perform app.log_action('kitchen.availability', 'menu_variants', p_variant_id::text,
                         null, jsonb_build_object('is_available', p_available, 'reason', p_reason));
end $fn$;
revoke all on function public.set_variant_available(uuid, boolean, text) from public;
grant execute on function public.set_variant_available(uuid, boolean, text) to authenticated, service_role;

create or replace function public.record_waste(
  p_variant_id uuid, p_qty int, p_reason text, p_note text default null
) returns void language plpgsql security definer set search_path = public, app as $fn$
declare v_old int; v_new int;
begin
  if not app.has_perm('kitchen.record_waste') then
    raise exception 'forbidden' using errcode = 'insufficient_privilege';
  end if;
  if coalesce(p_qty, 0) <= 0 then raise exception 'bad_qty' using errcode = 'check_violation'; end if;
  select available_qty into v_old from public.menu_variants where id = p_variant_id;
  if not found then raise exception 'variant_not_found' using errcode = 'no_data_found'; end if;
  v_new := greatest(0, v_old - p_qty);
  update public.menu_variants
     set available_qty = v_new, track_availability = true,
         is_available = case when v_new = 0 then false else is_available end
   where id = p_variant_id;
  insert into public.food_stock_log (variant_id, delta, new_qty, reason, actor_id, portal_id, note)
  values (p_variant_id, -p_qty, v_new, 'waste', app.jwt_sub(), app.current_portal_id(),
          coalesce(nullif(trim(p_reason), ''), p_note));
  perform app.log_action('kitchen.waste', 'menu_variants', p_variant_id::text,
                         jsonb_build_object('available_qty', v_old),
                         jsonb_build_object('available_qty', v_new, 'wasted', p_qty, 'reason', p_reason));
end $fn$;
revoke all on function public.record_waste(uuid, int, text, text) from public;
grant execute on function public.record_waste(uuid, int, text, text) to authenticated, service_role;

alter publication supabase_realtime add table public.menu_variants;

-- Created ahead of its "Attendance & business settings" section below:
-- app.promotion_is_valid_now() (in Promotions, just past this point) is a
-- `language sql` function, whose body — unlike a plpgsql function's — is
-- parsed and validated against the catalog at CREATE FUNCTION time, so the
-- table it queries must already exist here. RLS/policies for it stay in
-- their original spot since those only need the table to exist by then.
create table public.business_settings (
  id                        boolean primary key default true check (id),
  timezone                  text not null default 'UTC',
  business_day_start_minutes int not null default 0,
  currency_code             text not null default 'USD',
  week_start                int not null default 1,
  -- Configurable approval policy (spec: "Action + amount + role + policy
  -- = authorization" — never hardcode a threshold when the restaurant
  -- should be able to set its own). Null = no ceiling, i.e. today's
  -- behavior unchanged: anyone holding payments.refund can refund any
  -- amount. Set by an owner/manager in Settings; enforced inside
  -- refund_payment() below, never only in the UI.
  max_refund_without_approval_cents int,
  -- Receipt customization (0045) — null receipt_template_html means "use
  -- the built-in printed-receipt layout"; when set it's plain HTML with
  -- {{placeholder}} tokens substituted client-side before printing.
  -- brand_logo_url (0046) is this restaurant's one general-purpose logo —
  -- also used on receipts/PDFs; not duplicated under a receipt-specific name.
  brand_logo_url       text,
  receipt_footer_text  text,
  receipt_template_html text,
  -- Brand Kit (0046) — the restaurant's visual identity, in the SAME
  -- token shape apps/web/src/lib/theme.ts's ThemeTokens already defines
  -- (persisted here instead of per-browser localStorage). Null means "use
  -- the built-in default theme" throughout.
  brand_primary        text,
  brand_primary_fg     text,
  brand_bg_main        text,
  brand_bg_surface     text,
  brand_border         text,
  brand_text_body      text,
  brand_text_muted     text,
  brand_radius         text,
  brand_appearance     text check (brand_appearance in ('light', 'dark', 'system')),
  -- Restaurant contact fields (0048) — the "Restaurant Information"
  -- receipt section's data source; nothing in this schema stored these
  -- before (restaurant_name/slug live control-plane side only).
  address              text,
  phone                text,
  contact_email        text,
  website               text,
  tax_registration_number text,
  -- Structured, section-based receipt template (0048). Null = this
  -- restaurant never configured one — receipt rendering falls back to
  -- the existing receipt_footer_text/receipt_template_html behavior.
  receipt_config       jsonb,
  -- Portal identity (0049) — the browser <title> every portal page and
  -- sub-page inherits (via Next.js title templates). Null falls back to
  -- the restaurant's own name (control-plane tenants.restaurant_name).
  meta_title           text,
  -- Plan entitlements (0055) — synced from the control-plane subscription
  -- by apps/api/src/lib/entitlementSync.ts; not writable by tenant staff.
  -- Lets this project enforce its OWN plan (e.g. the Brand Kit trigger
  -- below) without a round trip to the control plane on every write.
  plan_tier            text,
  plan_features         text[] not null default '{}'
);
insert into public.business_settings (id) values (true);

-- Narrow, anon-safe read of ONLY the visual-identity columns (0046) — see
-- tenant-migrations/0046_brand_kit.sql for the full rationale.
create or replace function public.get_brand_kit()
returns table(
  logo_url text, primary_color text, primary_fg text,
  bg_main text, bg_surface text, border_color text,
  text_body text, text_muted text, radius text, appearance text,
  meta_title text
)
language sql stable security definer set search_path = public as $$
  select brand_logo_url, brand_primary, brand_primary_fg,
         brand_bg_main, brand_bg_surface, brand_border,
         brand_text_body, brand_text_muted, brand_radius, brand_appearance,
         meta_title
  from public.business_settings where id = true
$$;
revoke all on function public.get_brand_kit() from public;
grant execute on function public.get_brand_kit() to anon, authenticated, service_role;

-- Real, DB-level entitlement enforcement (0055) — only menu.branded has an
-- obvious single write surface (the brand_* columns) worth blocking; the
-- other enforceable features are read-side, gated in the frontend instead.
create or replace function app.enforce_plan_entitlements()
returns trigger language plpgsql as $fn$
begin
  -- business_settings' own mgr_write RLS policy lets anyone holding
  -- settings.update (e.g. the Owner) write ANY column on this row —
  -- without this check, a tenant could simply set plan_features itself
  -- and hand itself entitlements it doesn't actually have. Only the
  -- service-role sync (entitlementSync.ts) may ever change these two.
  if app.jwt_role() is distinct from 'service_role' then
    if new.plan_tier is distinct from old.plan_tier
    or new.plan_features is distinct from old.plan_features
    then
      raise exception 'plan_tier/plan_features are managed by the platform and cannot be changed directly'
        using errcode = '42501';
    end if;
  end if;

  if not ('menu.branded' = any(coalesce(new.plan_features, '{}'))) then
    if new.brand_logo_url      is distinct from old.brand_logo_url
    or new.brand_primary       is distinct from old.brand_primary
    or new.brand_primary_fg    is distinct from old.brand_primary_fg
    or new.brand_bg_main       is distinct from old.brand_bg_main
    or new.brand_bg_surface    is distinct from old.brand_bg_surface
    or new.brand_border        is distinct from old.brand_border
    or new.brand_text_body     is distinct from old.brand_text_body
    or new.brand_text_muted    is distinct from old.brand_text_muted
    or new.brand_radius        is distinct from old.brand_radius
    or new.brand_appearance    is distinct from old.brand_appearance
    then
      raise exception 'menu.branded is not included in this restaurant''s current plan'
        using errcode = '42501';
    end if;
  end if;
  return new;
end;
$fn$;

create trigger enforce_plan_entitlements_brand
  before update on public.business_settings
  for each row execute function app.enforce_plan_entitlements();

-- ── Promotions ───────────────────────────────────────────────────────────
-- (app.promo_kind is created earlier, right before place_order() — see the
-- comment there.)
create table public.promotions (
  id                uuid primary key default gen_random_uuid(),
  name              text not null,
  kind              app.promo_kind not null default 'percent',
  value_bps         int check (value_bps between 0 and 10000), -- for percent
  value_cents       int check (value_cents >= 0),              -- for fixed
  code              text unique,
  min_subtotal_cents int not null default 0,
  active            boolean not null default true,
  starts_at         timestamptz,
  ends_at           timestamptz,
  -- Happy-hour scheduling (spec: time-based scheduling): both null means
  -- "every day, all day" — the pre-existing unscheduled behavior.
  days_of_week      smallint[], -- 0=Sunday..6=Saturday; null = every day
  start_time        time,       -- null = no lower bound
  end_time          time,       -- null = no upper bound
  -- Usage limit (spec: promo codes with usage limits). usage_count is bumped
  -- atomically by place_order() at redemption time — the same
  -- update-where-still-true-then-check-affected-rows pattern used for deal
  -- and variant availability, so a race for the last redemption can't
  -- double-spend it. Per-customer limits are deferred: this system has no
  -- customer identity (guest orders carry only a free-text name), so there
  -- is nothing stable to key a per-customer count on yet.
  usage_limit_total int check (usage_limit_total is null or usage_limit_total > 0),
  usage_count       int not null default 0,
  -- Auto-apply (spec: automatic happy-hour/time-based discounts that need
  -- no code): place_order() applies the best eligible auto_apply promotion
  -- itself when no code was entered (or the entered one didn't discount
  -- anything) — see best_auto_promotion() below. A code-bearing promo may
  -- ALSO be auto_apply; the two are independent.
  auto_apply        boolean not null default false,
  -- BOGO (spec: buy-X-get-Y). Only meaningful when kind = 'bogo' — the
  -- other kinds leave these null, same convention as value_bps/value_cents
  -- being null for the kind that doesn't use them. v1 scope: one specific
  -- menu item, code-required (not auto_apply — see best_auto_promotion()),
  -- computed from the order's own lines at redemption time since it needs
  -- to know how many of that item were actually bought, not just the
  -- subtotal (see bogo_discount_for_order() below).
  bogo_menu_item_id     uuid references public.menu_items(id) on delete cascade,
  bogo_buy_qty          int check (bogo_buy_qty is null or bogo_buy_qty > 0),
  bogo_get_qty          int check (bogo_get_qty is null or bogo_get_qty > 0),
  bogo_get_discount_bps int check (bogo_get_discount_bps is null or bogo_get_discount_bps between 0 and 10000),
  created_at        timestamptz not null default now()
);

-- discount fields on orders (place_order takes p_discount_cents)
alter table public.orders add column discount_cents int not null default 0 check (discount_cents >= 0);
alter table public.orders add column promo_code text;

-- Every validity rule a promotion must pass to apply RIGHT NOW, shared by
-- promo_discount(), best_auto_promotion() and place_order()'s explicit-code
-- lookup so they can never disagree about whether a promotion is currently
-- eligible. Takes the whole row (avoids re-querying it) plus the order
-- subtotal being evaluated against min_subtotal_cents.
create or replace function app.promotion_is_valid_now(p public.promotions, p_subtotal_cents int)
returns boolean language sql stable as $fn$
  select p.active
     and p_subtotal_cents >= p.min_subtotal_cents
     and (p.starts_at is null or p.starts_at <= now())
     and (p.ends_at is null or p.ends_at >= now())
     and (p.usage_limit_total is null or p.usage_count < p.usage_limit_total)
     and (p.days_of_week is null or extract(
            dow from (now() at time zone coalesce((select timezone from public.business_settings where id), 'UTC'))
          )::smallint = any(p.days_of_week))
     and (p.start_time is null or
          (now() at time zone coalesce((select timezone from public.business_settings where id), 'UTC'))::time >= p.start_time)
     and (p.end_time is null or
          (now() at time zone coalesce((select timezone from public.business_settings where id), 'UTC'))::time <= p.end_time);
$fn$;

-- BOGO discount for an already-placed order's lines: total qty of the
-- target item actually bought (à la carte lines only — deal-embedded
-- copies of the item don't count, same as everywhere else in this file
-- that reasons about "what was really purchased"), how many of those
-- qualify as the discounted "get" units under buy_qty/get_qty, and which
-- specific units get discounted — the CHEAPEST ones first (the
-- customer-favorable, standard retail convention when variants price
-- differently), each by bogo_get_discount_bps.
create or replace function public.bogo_discount_for_order(p_order_id uuid, p_promotion_id uuid)
returns int language plpgsql stable security definer set search_path = public, app as $fn$
declare
  v_buy int; v_get int; v_bps int; v_item_id uuid;
  v_total_qty int; v_free_units int; v_remaining int; v_take int;
  v_discount int := 0;
  v_line record;
begin
  select bogo_buy_qty, bogo_get_qty, bogo_get_discount_bps, bogo_menu_item_id
    into v_buy, v_get, v_bps, v_item_id
    from public.promotions where id = p_promotion_id and kind = 'bogo';
  if v_item_id is null or v_buy is null or v_get is null then
    return 0;
  end if;

  select coalesce(sum(qty), 0) into v_total_qty
    from public.order_lines
   where order_id = p_order_id and menu_item_id = v_item_id and deal_id is null;

  v_free_units := (v_total_qty / (v_buy + v_get)) * v_get;
  if v_free_units <= 0 then
    return 0;
  end if;

  v_remaining := v_free_units;
  for v_line in
    select qty, unit_price_cents from public.order_lines
     where order_id = p_order_id and menu_item_id = v_item_id and deal_id is null
     order by unit_price_cents asc
  loop
    exit when v_remaining <= 0;
    v_take := least(v_line.qty, v_remaining);
    v_discount := v_discount + round(v_take * v_line.unit_price_cents * coalesce(v_bps, 0) / 10000.0);
    v_remaining := v_remaining - v_take;
  end loop;

  return v_discount;
end;
$fn$;
revoke all on function public.bogo_discount_for_order(uuid, uuid) from public;
grant execute on function public.bogo_discount_for_order(uuid, uuid) to authenticated, service_role;

-- Validate a code and return the discount for a given subtotal (0 if
-- invalid, or if it's a BOGO code — that needs the actual cart contents to
-- compute, which this endpoint doesn't have; see bogo_discount_for_order())
-- — schedule, usage-limit and min-subtotal checks all live in
-- app.promotion_is_valid_now() so the storefront's live preview
-- (/api/public/promo) and place_order's real redemption can never disagree
-- about whether a code is currently valid.
create or replace function public.promo_discount(p_code text, p_subtotal_cents int)
returns int language sql stable security definer set search_path = public, app as $fn$
  select coalesce((
    select case
      when p.kind = 'percent' then (p_subtotal_cents * coalesce(p.value_bps, 0) / 10000)
      when p.kind = 'fixed' then least(coalesce(p.value_cents, 0), p_subtotal_cents)
      else 0
    end
    from public.promotions p
    where lower(p.code) = lower(p_code)
      and app.promotion_is_valid_now(p, p_subtotal_cents)
    limit 1
  ), 0);
$fn$;
grant execute on function public.promo_discount(text, int) to authenticated, service_role, anon;

-- The single best currently-eligible auto_apply promotion for a subtotal
-- (same validity checks as promo_discount, minus the code match — instead
-- filtered to auto_apply promotions, ranked by whichever discounts the
-- most). place_order() calls this when no explicit code produced a
-- discount, so a scheduled happy-hour promo actually fires on its own —
-- the gap a code-only design would otherwise leave. BOGO is excluded here:
-- auto-apply BOGO would need this to know cart contents, not just the
-- subtotal — deferred, BOGO is code-required for now (see the table comment).
create or replace function public.best_auto_promotion(p_subtotal_cents int)
returns table (id uuid, discount_cents int)
language sql stable security definer set search_path = public, app as $fn$
  select p.id,
         case
           when p.kind = 'percent' then (p_subtotal_cents * coalesce(p.value_bps, 0) / 10000)
           else least(coalesce(p.value_cents, 0), p_subtotal_cents)
         end as discount_cents
    from public.promotions p
   where p.auto_apply
     and p.kind in ('percent', 'fixed')
     and app.promotion_is_valid_now(p, p_subtotal_cents)
   order by discount_cents desc
   limit 1;
$fn$;
grant execute on function public.best_auto_promotion(int) to authenticated, service_role;

-- Storefront code preview: unlike promo_discount() (which folds "invalid"
-- and "valid but this endpoint can't compute it" into the same 0), this
-- tells the caller WHICH one it is — a BOGO code is real and will apply at
-- checkout, it just can't show a dollar figure without the actual cart.
create or replace function public.promo_preview(p_code text, p_subtotal_cents int)
returns table (kind app.promo_kind, discount_cents int)
language sql stable security definer set search_path = public, app as $fn$
  select p.kind,
         case
           when p.kind = 'percent' then (p_subtotal_cents * coalesce(p.value_bps, 0) / 10000)
           when p.kind = 'fixed' then least(coalesce(p.value_cents, 0), p_subtotal_cents)
           else 0
         end
    from public.promotions p
   where lower(p.code) = lower(p_code) and app.promotion_is_valid_now(p, p_subtotal_cents)
   limit 1;
$fn$;
grant execute on function public.promo_preview(text, int) to authenticated, service_role, anon;

alter table public.promotions enable row level security;
create policy staff_read on public.promotions for select using (app.has_perm('menu.view') or app.is_staff());
create policy mgr_write on public.promotions for all using (app.has_perm('menu.update') or app.can_write()) with check (app.has_perm('menu.update') or app.can_write());
-- anon may read active promos so the storefront can validate a code
create policy guest_read on public.promotions for select using (active);

-- One row per successful promo-code redemption (spec: promotion analytics).
-- Written only by place_order() (security definer) at the point usage_count
-- is bumped — never directly by staff or the storefront.
create table public.promotion_redemptions (
  id            uuid primary key default gen_random_uuid(),
  promotion_id  uuid not null references public.promotions(id) on delete cascade,
  order_id      uuid references public.orders(id) on delete set null,
  discount_cents int not null,
  redeemed_at   timestamptz not null default now()
);
create index promotion_redemptions_promo_idx on public.promotion_redemptions(promotion_id, redeemed_at desc);
alter table public.promotion_redemptions enable row level security;
create policy staff_read on public.promotion_redemptions for select using (app.has_perm('menu.view') or app.is_staff());

-- Per-promotion redemption count, total discount given and total revenue of
-- the orders it was applied to, over an optional window (both bounds null =
-- all time). Same authoritative-calc-layer principle as period_profitability
-- etc: this is the one place that answers "how is this promo doing" for
-- both the Promotions page and the AI assistant.
create or replace function public.promotion_performance(p_from timestamptz default null, p_to timestamptz default null)
returns table (
  promotion_id uuid, name text, code text, kind app.promo_kind,
  redemptions bigint, total_discount_cents bigint, total_order_revenue_cents bigint,
  usage_limit_total int, usage_count int
)
language plpgsql stable security definer set search_path = public, app as $fn$
begin
  if not app.has_perm('menu.view') then
    raise exception 'forbidden' using errcode = 'insufficient_privilege';
  end if;
  return query
    select p.id, p.name, p.code, p.kind,
           count(r.id)::bigint,
           coalesce(sum(r.discount_cents), 0)::bigint,
           coalesce(sum(o.total_cents), 0)::bigint,
           p.usage_limit_total, p.usage_count
      from public.promotions p
      left join public.promotion_redemptions r
        on r.promotion_id = p.id
       and (p_from is null or r.redeemed_at >= p_from)
       and (p_to   is null or r.redeemed_at <  p_to)
      left join public.orders o on o.id = r.order_id
     group by p.id, p.name, p.code, p.kind, p.usage_limit_total, p.usage_count
     order by count(r.id) desc, p.name;
end;
$fn$;
revoke all on function public.promotion_performance(timestamptz, timestamptz) from public;
grant execute on function public.promotion_performance(timestamptz, timestamptz) to authenticated, service_role;

-- ── Suppliers & purchasing ───────────────────────────────────────────────
create type app.po_status as enum ('draft', 'sent', 'partial', 'received', 'cancelled');

create table public.suppliers (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  contact_name  text,
  email         text,
  phone         text,
  address       text,
  payment_terms text,
  notes         text,
  currency            text not null default 'USD',
  credit_period_days  int not null default 30,   -- used to default an invoice's due_date when not stated
  preferred_payment_method text,
  is_active           boolean not null default true,
  created_at    timestamptz not null default now()
);

create table public.po_counter (
  id boolean primary key default true check (id),
  next_number bigint not null default 1
);
insert into public.po_counter default values;

create table public.purchase_orders (
  id          uuid primary key default gen_random_uuid(),
  po_number   bigint not null unique,
  supplier_id uuid references public.suppliers(id) on delete set null,
  status      app.po_status not null default 'draft',
  expected_at date,
  notes       text,
  -- Approval gate (spec §6-7): a PO can't be sent until approved_at is set.
  -- Kept as a plain timestamp rather than new enum values — safer than an
  -- ALTER TYPE ADD VALUE mid-migration, and simpler than it needs to be.
  requested_by       uuid,
  approved_by        uuid,
  approved_at        timestamptz,
  sent_at            timestamptz,
  payment_terms_days int,
  subtotal_cents     int not null default 0,   -- maintained by a trigger off the lines below
  created_at  timestamptz not null default now(),
  received_at timestamptz
);

create table public.purchase_order_lines (
  id                uuid primary key default gen_random_uuid(),
  purchase_order_id uuid not null references public.purchase_orders(id) on delete cascade,
  inventory_item_id uuid references public.inventory_items(id) on delete set null,
  description       text not null,
  qty               numeric(14,3) not null check (qty > 0),
  unit_cost_cents   int not null default 0 check (unit_cost_cents >= 0),
  received_qty       numeric(14,3) not null default 0,
  -- Accept/reject split on receiving (spec §10): only (received_qty -
  -- rejected_qty) ever reaches inventory — see receive_purchase_order_line().
  rejected_qty       numeric(14,3) not null default 0,
  reject_reason      text
);
create index po_lines_po_idx on public.purchase_order_lines(purchase_order_id);

create or replace function app.recalc_po_subtotal() returns trigger
language plpgsql set search_path = public, app as $fn$
declare v_po uuid;
begin
  v_po := coalesce(new.purchase_order_id, old.purchase_order_id);
  update public.purchase_orders
     set subtotal_cents = coalesce(
       (select sum(pol.qty * pol.unit_cost_cents) from public.purchase_order_lines pol where pol.purchase_order_id = v_po), 0)
   where id = v_po;
  return null;
end $fn$;
create trigger recalc_po_subtotal after insert or update or delete on public.purchase_order_lines
  for each row execute function app.recalc_po_subtotal();

alter table public.suppliers enable row level security;
alter table public.purchase_orders enable row level security;
alter table public.purchase_order_lines enable row level security;
alter table public.po_counter enable row level security; -- functions only
create policy staff_read on public.suppliers for select using (app.has_perm('supplier.view') or app.is_staff());
create policy mgr_write on public.suppliers for all using (app.has_perm('supplier.manage') or app.can_write()) with check (app.has_perm('supplier.manage') or app.can_write());
create policy staff_read on public.purchase_orders for select using (app.has_perm('purchases.view') or app.is_staff());
create policy mgr_write on public.purchase_orders for all using (app.has_perm('purchases.update') or app.can_write()) with check (app.has_perm('purchases.update') or app.can_write());
create policy staff_read on public.purchase_order_lines for select using (app.has_perm('purchases.view') or app.is_staff());
create policy mgr_write on public.purchase_order_lines for all using (app.has_perm('purchases.update') or app.can_write()) with check (app.has_perm('purchases.update') or app.can_write());

create or replace function public.next_po_number() returns bigint
language plpgsql security definer set search_path = public, app as $fn$
declare v bigint;
begin
  update public.po_counter set next_number = next_number + 1 where id returning next_number - 1 into v;
  return v;
end $fn$;
grant execute on function public.next_po_number() to authenticated, service_role;

create or replace function public.approve_purchase_order(p_po_id uuid) returns void
language plpgsql security definer set search_path = public, app as $fn$
begin
  if not (app.has_perm('purchases.approve') or app.can_write()) then
    raise exception 'forbidden' using errcode = 'insufficient_privilege';
  end if;
  update public.purchase_orders set approved_by = app.jwt_sub(), approved_at = now()
   where id = p_po_id and status = 'draft';
  if not found then raise exception 'not_approvable' using errcode = 'check_violation'; end if;
end $fn$;
revoke all on function public.approve_purchase_order(uuid) from public;
grant execute on function public.approve_purchase_order(uuid) to authenticated, service_role;

-- A PO can't be sent until it's been approved (spec §6-7).
create or replace function public.send_purchase_order(p_po_id uuid) returns void
language plpgsql security definer set search_path = public, app as $fn$
declare v_approved timestamptz;
begin
  if not (app.has_perm('purchases.update') or app.can_write()) then
    raise exception 'forbidden' using errcode = 'insufficient_privilege';
  end if;
  select approved_at into v_approved from public.purchase_orders where id = p_po_id;
  if not found then raise exception 'po_not_found' using errcode = 'no_data_found'; end if;
  if v_approved is null then raise exception 'not_approved' using errcode = 'check_violation'; end if;
  update public.purchase_orders set status = 'sent', sent_at = now() where id = p_po_id and status = 'draft';
end $fn$;
revoke all on function public.send_purchase_order(uuid) from public;
grant execute on function public.send_purchase_order(uuid) to authenticated, service_role;

-- Receive a PO in full: every outstanding line goes to fully received.
-- purchase_order_lines.qty/received_qty are in the item's PURCHASE unit
-- (e.g. "10 KG bags"); purchase_unit_to_base converts that to the base unit
-- stock_qty is kept in (spec §6-7). Cost updates by weighted average across
-- the existing balance and this receipt (spec §8) — the one costing method
-- used everywhere, including the recipe-cost snapshot on order_lines.
create or replace function public.receive_purchase_order(p_po_id uuid) returns void
language plpgsql security definer set search_path = public, app as $fn$
declare r record; v_factor numeric; v_old_stock numeric; v_old_cost numeric;
  v_recv_base numeric; v_receipt_cost_per_base numeric; v_new_cost numeric;
begin
  if not (app.has_perm('purchases.receive') or app.has_perm('inventory.manage_purchases') or app.can_write()) then
    raise exception 'forbidden' using errcode = 'insufficient_privilege';
  end if;
  for r in
    select id, inventory_item_id, qty, received_qty, unit_cost_cents from public.purchase_order_lines
    where purchase_order_id = p_po_id
  loop
    if r.inventory_item_id is not null and r.qty > r.received_qty then
      select purchase_unit_to_base, stock_qty, cost_cents_per_base_unit
        into v_factor, v_old_stock, v_old_cost
        from public.inventory_items where id = r.inventory_item_id;
      v_recv_base := (r.qty - r.received_qty) * coalesce(v_factor, 1);
      v_receipt_cost_per_base := r.unit_cost_cents / greatest(coalesce(v_factor, 1), 0.0001);
      v_new_cost := case when (coalesce(v_old_stock, 0) + v_recv_base) > 0
        then (coalesce(v_old_stock, 0) * coalesce(v_old_cost, 0) + v_recv_base * v_receipt_cost_per_base)
             / (coalesce(v_old_stock, 0) + v_recv_base)
        else coalesce(v_old_cost, 0) end;
      update public.inventory_items
         set stock_qty = stock_qty + v_recv_base, cost_cents_per_base_unit = v_new_cost
       where id = r.inventory_item_id;
      insert into public.stock_ledger (inventory_item_id, delta_qty, reason, note, unit_cost_cents_base)
      values (r.inventory_item_id, v_recv_base, 'restock', 'PO receipt', v_receipt_cost_per_base);
    end if;
    update public.purchase_order_lines set received_qty = qty where id = r.id;
  end loop;
  update public.purchase_orders set status = 'received', received_at = now() where id = p_po_id;
end $fn$;
grant execute on function public.receive_purchase_order(uuid) to authenticated, service_role;

-- Partial receiving with an accept/reject split (spec §10, §22): p_qty is
-- the total physically delivered against this line (up to whatever's still
-- outstanding); p_rejected_qty is however much of THAT was rejected
-- (damaged/wrong/short). Only the accepted portion (p_qty - p_rejected_qty)
-- ever reaches inventory — never marks the rest of the PO received. Same
-- weighted-average costing as the full receive above.
drop function if exists public.receive_purchase_order_line(uuid, numeric);
create or replace function public.receive_purchase_order_line(
  p_line_id uuid, p_qty numeric, p_rejected_qty numeric default 0, p_reject_reason text default null
) returns void
language plpgsql security definer set search_path = public, app as $fn$
declare
  r record; v_factor numeric; v_old_stock numeric; v_old_cost numeric;
  v_take numeric; v_accept numeric; v_recv_base numeric; v_receipt_cost_per_base numeric; v_new_cost numeric;
  v_remaining_lines int;
begin
  if not (app.has_perm('purchases.receive') or app.has_perm('inventory.manage_purchases') or app.can_write()) then
    raise exception 'forbidden' using errcode = 'insufficient_privilege';
  end if;
  if coalesce(p_qty, 0) <= 0 then raise exception 'bad_qty' using errcode = 'check_violation'; end if;
  if coalesce(p_rejected_qty, 0) < 0 or coalesce(p_rejected_qty, 0) > p_qty then
    raise exception 'bad_rejected_qty' using errcode = 'check_violation';
  end if;
  select id, purchase_order_id, inventory_item_id, qty, received_qty, unit_cost_cents
    into r from public.purchase_order_lines where id = p_line_id;
  if not found then raise exception 'line_not_found' using errcode = 'foreign_key_violation'; end if;
  v_take := least(p_qty, r.qty - r.received_qty);
  if v_take <= 0 then raise exception 'nothing_outstanding' using errcode = 'check_violation'; end if;
  v_accept := v_take - least(coalesce(p_rejected_qty, 0), v_take);

  if r.inventory_item_id is not null and v_accept > 0 then
    select purchase_unit_to_base, stock_qty, cost_cents_per_base_unit
      into v_factor, v_old_stock, v_old_cost
      from public.inventory_items where id = r.inventory_item_id;
    v_recv_base := v_accept * coalesce(v_factor, 1);
    v_receipt_cost_per_base := r.unit_cost_cents / greatest(coalesce(v_factor, 1), 0.0001);
    v_new_cost := case when (coalesce(v_old_stock, 0) + v_recv_base) > 0
      then (coalesce(v_old_stock, 0) * coalesce(v_old_cost, 0) + v_recv_base * v_receipt_cost_per_base)
           / (coalesce(v_old_stock, 0) + v_recv_base)
      else coalesce(v_old_cost, 0) end;
    update public.inventory_items
       set stock_qty = stock_qty + v_recv_base, cost_cents_per_base_unit = v_new_cost
     where id = r.inventory_item_id;
    insert into public.stock_ledger (inventory_item_id, delta_qty, reason, note, unit_cost_cents_base)
    values (r.inventory_item_id, v_recv_base, 'restock', 'PO partial receipt', v_receipt_cost_per_base);
  end if;
  update public.purchase_order_lines
     set received_qty = received_qty + v_take,
         rejected_qty = rejected_qty + coalesce(p_rejected_qty, 0),
         reject_reason = coalesce(p_reject_reason, reject_reason)
   where id = p_line_id;

  select count(*) into v_remaining_lines from public.purchase_order_lines
   where purchase_order_id = r.purchase_order_id and received_qty < qty;
  update public.purchase_orders
     set status = case when v_remaining_lines = 0 then 'received'::app.po_status else 'partial'::app.po_status end,
         received_at = case when v_remaining_lines = 0 then now() else received_at end
   where id = r.purchase_order_id;
end $fn$;
revoke all on function public.receive_purchase_order_line(uuid, numeric, numeric, text) from public;
grant execute on function public.receive_purchase_order_line(uuid, numeric, numeric, text) to authenticated, service_role;

-- ── Supplier price catalog (spec §4-5) ──────────────────────────────────────
-- A supplier isn't just linked to a generic ingredient — the same ingredient
-- can have a different price per supplier, and that price's history must
-- never be overwritten (only ever appended to).
create table public.supplier_items (
  id                     uuid primary key default gen_random_uuid(),
  supplier_id            uuid not null references public.suppliers(id) on delete cascade,
  inventory_item_id      uuid not null references public.inventory_items(id) on delete cascade,
  supplier_sku           text,
  supplier_item_name     text,
  purchase_unit_label    text,
  purchase_unit_to_base  numeric(14,4) not null default 1 check (purchase_unit_to_base > 0),
  current_price_cents    int not null default 0 check (current_price_cents >= 0),
  moq                    numeric(14,3),
  lead_time_days         int,
  is_preferred           boolean not null default false,
  is_active              boolean not null default true,
  updated_at             timestamptz not null default now(),
  unique (supplier_id, inventory_item_id)
);
create index supplier_items_item_idx on public.supplier_items(inventory_item_id);

create table public.supplier_price_history (
  id                 uuid primary key default gen_random_uuid(),
  supplier_item_id   uuid not null references public.supplier_items(id) on delete cascade,
  old_price_cents    int,
  new_price_cents    int not null,
  pct_change         numeric(7,2),
  effective_date     date not null default current_date,
  source             text not null default 'manual' check (source in ('manual','purchase_order','invoice')),
  reference_id       uuid,
  created_at         timestamptz not null default now()
);
create index supplier_price_history_item_idx on public.supplier_price_history(supplier_item_id, effective_date desc);

alter table public.supplier_items enable row level security;
alter table public.supplier_price_history enable row level security;
create policy staff_read on public.supplier_items for select using (app.has_perm('supplier.view') or app.is_staff());
create policy mgr_write on public.supplier_items for all using (app.has_perm('supplier.manage') or app.can_write()) with check (app.has_perm('supplier.manage') or app.can_write());
create policy staff_read on public.supplier_price_history for select using (app.has_perm('supplier.view') or app.is_staff());

-- Explicit price update: records the change in supplier_price_history rather
-- than silently overwriting (spec §5). Also used internally by
-- match_supplier_invoice() when an in-tolerance invoice line reveals a new
-- price (source='invoice').
create or replace function public.set_supplier_item_price(
  p_supplier_item_id uuid, p_new_price_cents int, p_source text default 'manual', p_reference_id uuid default null
) returns void
language plpgsql security definer set search_path = public, app as $fn$
declare v_old int;
begin
  if not (app.has_perm('supplier.manage') or app.can_write()) then
    raise exception 'forbidden' using errcode = 'insufficient_privilege';
  end if;
  if coalesce(p_new_price_cents, 0) < 0 then raise exception 'bad_price' using errcode = 'check_violation'; end if;
  select current_price_cents into v_old from public.supplier_items where id = p_supplier_item_id;
  if not found then raise exception 'supplier_item_not_found' using errcode = 'foreign_key_violation'; end if;
  update public.supplier_items set current_price_cents = p_new_price_cents, updated_at = now()
   where id = p_supplier_item_id;
  insert into public.supplier_price_history
    (supplier_item_id, old_price_cents, new_price_cents, pct_change, source, reference_id)
  values (p_supplier_item_id, v_old, p_new_price_cents,
    case when coalesce(v_old,0) > 0 then round((p_new_price_cents - v_old)::numeric / v_old * 1000) / 10 else null end,
    coalesce(nullif(p_source,''),'manual'), p_reference_id);
end $fn$;
revoke all on function public.set_supplier_item_price(uuid, int, text, uuid) from public;
grant execute on function public.set_supplier_item_price(uuid, int, text, uuid) to authenticated, service_role;

-- ── Purchasing settings — matching tolerances (spec §15) ───────────────────
create table public.purchasing_settings (
  id                     boolean primary key default true check (id),
  qty_tolerance_pct      numeric(5,2) not null default 2,
  price_tolerance_pct    numeric(5,2) not null default 1
);
insert into public.purchasing_settings (id) values (true);
alter table public.purchasing_settings enable row level security;
create policy staff_read on public.purchasing_settings for select using (app.has_perm('finance.view') or app.is_staff());
create policy mgr_write on public.purchasing_settings for all using (app.has_perm('finance.manage_purchases') or app.can_write()) with check (app.has_perm('finance.manage_purchases') or app.can_write());

-- ── Supplier invoices (spec §11-16) ─────────────────────────────────────────
create type app.invoice_status as enum (
  'received','matched','on_hold','approved','partially_paid','paid','cancelled'
);

create table public.invoice_counter (
  id boolean primary key default true check (id),
  next_number bigint not null default 1
);
insert into public.invoice_counter default values;
create or replace function public.next_invoice_ref() returns bigint
language plpgsql security definer set search_path = public, app as $fn$
declare v bigint;
begin
  update public.invoice_counter set next_number = next_number + 1 where id returning next_number - 1 into v;
  return v;
end $fn$;
grant execute on function public.next_invoice_ref() to authenticated, service_role;

create table public.supplier_invoices (
  id                     uuid primary key default gen_random_uuid(),
  invoice_ref            bigint not null unique default public.next_invoice_ref(), -- our own sequence, distinct from the supplier's own number
  supplier_id            uuid not null references public.suppliers(id) on delete restrict,
  purchase_order_id      uuid references public.purchase_orders(id) on delete set null,
  supplier_invoice_number text not null,
  invoice_date           date not null,
  due_date               date,                          -- defaulted from supplier.credit_period_days if not given
  currency               text not null default 'USD',
  subtotal_cents         int not null default 0 check (subtotal_cents >= 0),
  tax_cents              int not null default 0 check (tax_cents >= 0),
  discount_cents         int not null default 0 check (discount_cents >= 0),
  delivery_fee_cents     int not null default 0 check (delivery_fee_cents >= 0),
  total_cents            int not null default 0 check (total_cents >= 0),
  status                 app.invoice_status not null default 'received',
  attachment_path        text,                          -- path in the private 'supplier-invoices' bucket
  notes                  text,
  created_by             uuid,
  created_at             timestamptz not null default now(),
  -- Deterministic duplicate-invoice guard (spec §36): the same supplier
  -- can't have the same invoice number twice.
  unique (supplier_id, supplier_invoice_number)
);
create index supplier_invoices_supplier_idx on public.supplier_invoices(supplier_id, invoice_date desc);
create index supplier_invoices_status_idx on public.supplier_invoices(status);

create or replace function app.default_invoice_due_date() returns trigger
language plpgsql set search_path = public, app as $fn$
declare v_days int;
begin
  if new.due_date is null then
    select credit_period_days into v_days from public.suppliers where id = new.supplier_id;
    new.due_date := new.invoice_date + make_interval(days => coalesce(v_days, 30));
  end if;
  return new;
end $fn$;
create trigger default_invoice_due_date before insert on public.supplier_invoices
  for each row execute function app.default_invoice_due_date();

create table public.supplier_invoice_lines (
  id                uuid primary key default gen_random_uuid(),
  invoice_id        uuid not null references public.supplier_invoices(id) on delete cascade,
  po_line_id        uuid references public.purchase_order_lines(id) on delete set null,
  inventory_item_id uuid references public.inventory_items(id) on delete set null,
  description       text not null,
  qty               numeric(14,3) not null check (qty > 0),
  unit_cost_cents   int not null default 0 check (unit_cost_cents >= 0),
  line_total_cents  int not null default 0 check (line_total_cents >= 0)
);
create index supplier_invoice_lines_invoice_idx on public.supplier_invoice_lines(invoice_id);

alter table public.supplier_invoices enable row level security;
alter table public.supplier_invoice_lines enable row level security;
create policy staff_read on public.supplier_invoices for select using (app.has_perm('invoices.view') or app.has_perm('purchases.view') or app.is_staff());
create policy mgr_write on public.supplier_invoices for all using (app.has_perm('invoices.create') or app.can_write()) with check (app.has_perm('invoices.create') or app.can_write());
create policy staff_read on public.supplier_invoice_lines for select using (app.has_perm('invoices.view') or app.has_perm('purchases.view') or app.is_staff());
create policy mgr_write on public.supplier_invoice_lines for all using (app.has_perm('invoices.create') or app.can_write()) with check (app.has_perm('invoices.create') or app.can_write());

-- Private bucket (spec §12 — never a public invoice URL): the app must mint
-- a signed URL to view an attachment.
insert into storage.buckets (id, name, public)
values ('supplier-invoices', 'supplier-invoices', false)
on conflict (id) do nothing;
create policy "supplier-invoices staff read" on storage.objects for select
  using (bucket_id = 'supplier-invoices' and (app.has_perm('invoices.view') or app.is_staff()));
create policy "supplier-invoices staff write" on storage.objects for all
  using (bucket_id = 'supplier-invoices' and (app.has_perm('invoices.create') or app.can_write()))
  with check (bucket_id = 'supplier-invoices' and (app.has_perm('invoices.create') or app.can_write()));

-- ── Payment holds (spec §16) ─────────────────────────────────────────────
create table public.supplier_payment_holds (
  id               uuid primary key default gen_random_uuid(),
  invoice_id       uuid not null references public.supplier_invoices(id) on delete cascade,
  reason           text not null,
  amount_cents     int not null check (amount_cents >= 0),
  status           text not null default 'open' check (status in ('open','resolved')),
  created_at       timestamptz not null default now(),
  created_by       uuid,
  resolved_at      timestamptz,
  resolved_by      uuid,
  resolution_note  text
);
create index supplier_payment_holds_invoice_idx on public.supplier_payment_holds(invoice_id);
create index supplier_payment_holds_open_idx on public.supplier_payment_holds(status) where status = 'open';
alter table public.supplier_payment_holds enable row level security;
create policy staff_read on public.supplier_payment_holds for select using (app.has_perm('payables.view') or app.has_perm('invoices.view') or app.is_staff());
create policy mgr_write on public.supplier_payment_holds for all using (app.has_perm('payables.manage') or app.can_write()) with check (app.has_perm('payables.manage') or app.can_write());

-- ── Credit notes (spec §19) ──────────────────────────────────────────────
create table public.supplier_credit_notes (
  id            uuid primary key default gen_random_uuid(),
  supplier_id   uuid not null references public.suppliers(id) on delete cascade,
  invoice_id    uuid references public.supplier_invoices(id) on delete set null,
  amount_cents  int not null check (amount_cents > 0),
  reason        text not null,
  credit_date   date not null default current_date,
  created_by    uuid,
  created_at    timestamptz not null default now()
);
create index supplier_credit_notes_supplier_idx on public.supplier_credit_notes(supplier_id, credit_date desc);
alter table public.supplier_credit_notes enable row level security;
create policy staff_read on public.supplier_credit_notes for select using (app.has_perm('payables.view') or app.is_staff());
create policy mgr_write on public.supplier_credit_notes for all using (app.has_perm('payables.manage') or app.can_write()) with check (app.has_perm('payables.manage') or app.can_write());

-- ── Supplier payments (spec §17, §20-21) ────────────────────────────────
create table public.supplier_payments (
  id            uuid primary key default gen_random_uuid(),
  supplier_id   uuid not null references public.suppliers(id) on delete restrict,
  amount_cents  int not null check (amount_cents > 0),
  method        text not null default 'bank_transfer',
  reference     text,
  paid_at       timestamptz not null default now(),
  note          text,
  created_by    uuid
);
create index supplier_payments_supplier_idx on public.supplier_payments(supplier_id, paid_at desc);

-- A single payment may be split across multiple invoices, and a single
-- invoice may be paid by multiple payments (spec §21) — never a bare
-- paid=true boolean on the invoice.
create table public.supplier_payment_allocations (
  id            uuid primary key default gen_random_uuid(),
  payment_id    uuid not null references public.supplier_payments(id) on delete cascade,
  invoice_id    uuid not null references public.supplier_invoices(id) on delete restrict,
  amount_cents  int not null check (amount_cents > 0),
  unique (payment_id, invoice_id)
);
create index supplier_payment_allocations_invoice_idx on public.supplier_payment_allocations(invoice_id);

alter table public.supplier_payments enable row level security;
alter table public.supplier_payment_allocations enable row level security;
create policy staff_read on public.supplier_payments for select using (app.has_perm('payables.view') or app.is_staff());
create policy mgr_write on public.supplier_payments for all using (app.has_perm('payables.record_payment') or app.can_write()) with check (app.has_perm('payables.record_payment') or app.can_write());
create policy staff_read on public.supplier_payment_allocations for select using (app.has_perm('payables.view') or app.is_staff());
create policy mgr_write on public.supplier_payment_allocations for all using (app.has_perm('payables.record_payment') or app.can_write()) with check (app.has_perm('payables.record_payment') or app.can_write());

-- Outstanding = total - allocated payments - credit notes. The ONE place
-- this is computed (spec §18, §59) — invoice status and supplier_payable()
-- both derive from this, never a separately-maintained balance.
create or replace function app.invoice_outstanding_cents(p_invoice_id uuid) returns int
language sql stable set search_path = public, app as $fn$
  select greatest(0,
    (select si.total_cents from public.supplier_invoices si where si.id = p_invoice_id)
    - coalesce((select sum(spa.amount_cents) from public.supplier_payment_allocations spa where spa.invoice_id = p_invoice_id), 0)
    - coalesce((select sum(scn.amount_cents) from public.supplier_credit_notes scn where scn.invoice_id = p_invoice_id), 0)
  )::int
$fn$;

-- ── Three-way matching (spec §14-15) ─────────────────────────────────────
-- Compares each invoice line against its linked PO line's price and actual
-- RECEIVED quantity (not ordered quantity — an invoice should match what
-- arrived). Within the configured tolerance: auto-match, and sync the
-- supplier's price catalog if the price moved. Outside tolerance, or an
-- invoice line with no PO line to check against: open a payment hold with
-- the specific reason, and put the whole invoice on hold — a defensible v1
-- simplification of true partial-line holds.
create or replace function public.match_supplier_invoice(p_invoice_id uuid) returns jsonb
language plpgsql security definer set search_path = public, app as $fn$
declare
  v_qty_tol numeric; v_price_tol numeric;
  v_line record; v_po_price int; v_recv_qty numeric;
  v_qty_diff_pct numeric; v_price_diff_pct numeric;
  v_all_ok boolean := true; v_unmatched_amount int := 0;
  v_sitem_id uuid; v_old_price int;
begin
  if not (app.has_perm('invoices.match') or app.can_write()) then
    raise exception 'forbidden' using errcode = 'insufficient_privilege';
  end if;
  select qty_tolerance_pct, price_tolerance_pct into v_qty_tol, v_price_tol from public.purchasing_settings;
  v_qty_tol := coalesce(v_qty_tol, 2); v_price_tol := coalesce(v_price_tol, 1);

  update public.supplier_payment_holds
     set status = 'resolved', resolved_at = now(), resolution_note = 'superseded by re-match'
   where invoice_id = p_invoice_id and status = 'open';

  for v_line in
    select sil.id, sil.qty, sil.unit_cost_cents, sil.line_total_cents, sil.po_line_id, sil.inventory_item_id
      from public.supplier_invoice_lines sil where sil.invoice_id = p_invoice_id
  loop
    if v_line.po_line_id is null then
      v_all_ok := false;
      v_unmatched_amount := v_unmatched_amount + v_line.line_total_cents;
      insert into public.supplier_payment_holds (invoice_id, reason, amount_cents, created_by)
        values (p_invoice_id, 'Invoice line not linked to a purchase order — needs manual review', v_line.line_total_cents, app.jwt_sub());
      continue;
    end if;

    select pol.received_qty, pol.unit_cost_cents into v_recv_qty, v_po_price
      from public.purchase_order_lines pol where pol.id = v_line.po_line_id;

    v_qty_diff_pct := case when coalesce(v_recv_qty,0) > 0
      then abs(v_line.qty - v_recv_qty) / v_recv_qty * 100 else 100 end;
    v_price_diff_pct := case when coalesce(v_po_price,0) > 0
      then abs(v_line.unit_cost_cents - v_po_price) / v_po_price::numeric * 100 else 100 end;

    if v_qty_diff_pct > v_qty_tol then
      v_all_ok := false;
      v_unmatched_amount := v_unmatched_amount + v_line.line_total_cents;
      insert into public.supplier_payment_holds (invoice_id, reason, amount_cents, created_by)
        values (p_invoice_id,
          format('Quantity mismatch: invoiced %s vs received %s (%s%% difference)', v_line.qty, coalesce(v_recv_qty,0), round(v_qty_diff_pct,1)),
          v_line.line_total_cents, app.jwt_sub());
    elsif v_price_diff_pct > v_price_tol then
      v_all_ok := false;
      v_unmatched_amount := v_unmatched_amount + v_line.line_total_cents;
      insert into public.supplier_payment_holds (invoice_id, reason, amount_cents, created_by)
        values (p_invoice_id,
          format('Price variance: invoiced %s vs PO %s per unit (%s%% difference)', v_line.unit_cost_cents, coalesce(v_po_price,0), round(v_price_diff_pct,1)),
          v_line.line_total_cents, app.jwt_sub());
    else
      if v_line.inventory_item_id is not null then
        select si.id, si.current_price_cents into v_sitem_id, v_old_price
          from public.supplier_items si
          join public.supplier_invoices inv on inv.id = p_invoice_id
         where si.supplier_id = inv.supplier_id and si.inventory_item_id = v_line.inventory_item_id;
        if v_sitem_id is not null and v_old_price is distinct from v_line.unit_cost_cents then
          perform public.set_supplier_item_price(v_sitem_id, v_line.unit_cost_cents, 'invoice', p_invoice_id);
        end if;
      end if;
    end if;
  end loop;

  update public.supplier_invoices
     set status = case when v_all_ok then 'matched'::app.invoice_status else 'on_hold'::app.invoice_status end
   where id = p_invoice_id;

  return jsonb_build_object('matched', v_all_ok, 'unmatched_amount_cents', v_unmatched_amount);
end $fn$;
revoke all on function public.match_supplier_invoice(uuid) from public;
grant execute on function public.match_supplier_invoice(uuid) to authenticated, service_role;

create or replace function public.approve_supplier_invoice(p_invoice_id uuid) returns void
language plpgsql security definer set search_path = public, app as $fn$
begin
  if not (app.has_perm('invoices.match') or app.has_perm('payables.manage') or app.can_write()) then
    raise exception 'forbidden' using errcode = 'insufficient_privilege';
  end if;
  update public.supplier_invoices set status = 'approved' where id = p_invoice_id and status = 'matched';
  if not found then raise exception 'not_approvable' using errcode = 'check_violation'; end if;
end $fn$;
revoke all on function public.approve_supplier_invoice(uuid) from public;
grant execute on function public.approve_supplier_invoice(uuid) to authenticated, service_role;

create or replace function public.resolve_payment_hold(p_hold_id uuid, p_resolution_note text) returns void
language plpgsql security definer set search_path = public, app as $fn$
declare v_invoice uuid; v_remaining int;
begin
  if not (app.has_perm('payables.manage') or app.can_write()) then
    raise exception 'forbidden' using errcode = 'insufficient_privilege';
  end if;
  update public.supplier_payment_holds
     set status = 'resolved', resolved_at = now(), resolved_by = app.jwt_sub(),
         resolution_note = coalesce(nullif(trim(p_resolution_note), ''), 'resolved')
   where id = p_hold_id and status = 'open'
   returning invoice_id into v_invoice;
  if not found then raise exception 'hold_not_found_or_resolved' using errcode = 'check_violation'; end if;

  select count(*) into v_remaining from public.supplier_payment_holds
   where invoice_id = v_invoice and status = 'open';
  if v_remaining = 0 then
    update public.supplier_invoices set status = 'matched' where id = v_invoice and status = 'on_hold';
  end if;
end $fn$;
revoke all on function public.resolve_payment_hold(uuid, text) from public;
grant execute on function public.resolve_payment_hold(uuid, text) to authenticated, service_role;

-- Record a supplier payment and allocate it across one or more invoices in
-- one atomic call (spec §17, §21). Never lets an allocation exceed either
-- the payment itself or the target invoice's own outstanding balance.
create or replace function public.record_supplier_payment(
  p_supplier_id uuid, p_amount_cents int, p_method text, p_reference text,
  p_allocations jsonb, p_note text default null
) returns uuid
language plpgsql security definer set search_path = public, app as $fn$
declare
  v_payment_id uuid; v_alloc jsonb; v_inv uuid; v_amt int; v_sum int := 0;
  v_outstanding int; v_inv_supplier uuid;
begin
  if not (app.has_perm('payables.record_payment') or app.can_write()) then
    raise exception 'forbidden' using errcode = 'insufficient_privilege';
  end if;
  if coalesce(p_amount_cents, 0) <= 0 then raise exception 'bad_amount' using errcode = 'check_violation'; end if;

  insert into public.supplier_payments (supplier_id, amount_cents, method, reference, note, created_by)
  values (p_supplier_id, p_amount_cents, coalesce(nullif(p_method,''),'bank_transfer'), nullif(p_reference,''), p_note, app.jwt_sub())
  returning id into v_payment_id;

  for v_alloc in select value from jsonb_array_elements(coalesce(p_allocations, '[]'::jsonb)) as t(value) loop
    v_inv := (v_alloc->>'invoice_id')::uuid;
    v_amt := (v_alloc->>'amount_cents')::int;
    if coalesce(v_amt, 0) <= 0 then continue; end if;

    select si.supplier_id into v_inv_supplier from public.supplier_invoices si where si.id = v_inv;
    if v_inv_supplier is null then raise exception 'invoice_not_found: %', v_inv using errcode = 'foreign_key_violation'; end if;
    if v_inv_supplier is distinct from p_supplier_id then
      raise exception 'invoice_supplier_mismatch: %', v_inv using errcode = 'check_violation';
    end if;
    v_outstanding := app.invoice_outstanding_cents(v_inv);
    if v_amt > v_outstanding then
      raise exception 'allocation_exceeds_outstanding: % > %', v_amt, v_outstanding using errcode = 'check_violation';
    end if;

    insert into public.supplier_payment_allocations (payment_id, invoice_id, amount_cents)
    values (v_payment_id, v_inv, v_amt);
    v_sum := v_sum + v_amt;

    update public.supplier_invoices
       set status = case when app.invoice_outstanding_cents(v_inv) = 0 then 'paid'::app.invoice_status else 'partially_paid'::app.invoice_status end
     where id = v_inv;
  end loop;

  if v_sum > p_amount_cents then
    raise exception 'allocations_exceed_payment: % > %', v_sum, p_amount_cents using errcode = 'check_violation';
  end if;
  return v_payment_id;
end $fn$;
revoke all on function public.record_supplier_payment(uuid, int, text, text, jsonb, text) from public;
grant execute on function public.record_supplier_payment(uuid, int, text, text, jsonb, text) to authenticated, service_role;

create or replace function public.record_supplier_credit_note(
  p_supplier_id uuid, p_invoice_id uuid, p_amount_cents int, p_reason text
) returns uuid
language plpgsql security definer set search_path = public, app as $fn$
declare v_id uuid; v_inv_supplier uuid;
begin
  if not (app.has_perm('payables.manage') or app.can_write()) then
    raise exception 'forbidden' using errcode = 'insufficient_privilege';
  end if;
  if coalesce(p_amount_cents, 0) <= 0 then raise exception 'bad_amount' using errcode = 'check_violation'; end if;
  if coalesce(trim(p_reason), '') = '' then raise exception 'reason_required' using errcode = 'check_violation'; end if;
  if p_invoice_id is not null then
    select si.supplier_id into v_inv_supplier from public.supplier_invoices si where si.id = p_invoice_id;
    if v_inv_supplier is distinct from p_supplier_id then
      raise exception 'invoice_supplier_mismatch' using errcode = 'check_violation';
    end if;
  end if;
  insert into public.supplier_credit_notes (supplier_id, invoice_id, amount_cents, reason, created_by)
  values (p_supplier_id, p_invoice_id, p_amount_cents, p_reason, app.jwt_sub())
  returning id into v_id;
  if p_invoice_id is not null then
    update public.supplier_invoices
       set status = case when app.invoice_outstanding_cents(p_invoice_id) = 0 then 'paid'::app.invoice_status else status end
     where id = p_invoice_id and status not in ('paid','cancelled');
  end if;
  return v_id;
end $fn$;
revoke all on function public.record_supplier_credit_note(uuid, uuid, int, text) from public;
grant execute on function public.record_supplier_credit_note(uuid, uuid, int, text) to authenticated, service_role;

-- ── ONE authoritative accounts-payable ledger (spec §18, §59) ─────────────
-- Every page/report/AI answer that states what a supplier is owed calls
-- this — never a second payable formula anywhere else.
create or replace function public.supplier_payable(p_supplier_id uuid default null)
returns table (
  supplier_id uuid, supplier_name text,
  invoiced_cents int, on_hold_cents int, approved_cents int,
  paid_cents int, credited_cents int, outstanding_cents int, overdue_cents int,
  open_invoices int, open_holds int
)
language plpgsql stable security definer set search_path = public, app as $fn$
begin
  if not (app.has_perm('payables.view') or app.has_perm('finance.view') or app.can_write()) then
    raise exception 'forbidden' using errcode = 'insufficient_privilege';
  end if;
  return query
    with inv as (
      select si.id, si.supplier_id as sup_id, si.total_cents, si.status, si.due_date,
             app.invoice_outstanding_cents(si.id) as outstanding
        from public.supplier_invoices si
       where si.status <> 'cancelled' and (p_supplier_id is null or si.supplier_id = p_supplier_id)
    ),
    hold as (
      select inv.sup_id, coalesce(sum(h.amount_cents),0)::int as sum_hold, count(*)::int as cnt_hold
        from public.supplier_payment_holds h
        join inv on inv.id = h.invoice_id
       where h.status = 'open'
       group by inv.sup_id
    ),
    paid as (
      select sp.supplier_id as sup_id, coalesce(sum(sp.amount_cents),0)::int as sum_paid
        from public.supplier_payments sp
       where p_supplier_id is null or sp.supplier_id = p_supplier_id
       group by sp.supplier_id
    ),
    credited as (
      select scn.supplier_id as sup_id, coalesce(sum(scn.amount_cents),0)::int as sum_credited
        from public.supplier_credit_notes scn
       where p_supplier_id is null or scn.supplier_id = p_supplier_id
       group by scn.supplier_id
    ),
    agg as (
      select inv.sup_id,
             coalesce(sum(inv.total_cents),0)::int as sum_invoiced,
             coalesce(sum(inv.total_cents) filter (where inv.status = 'approved'),0)::int as sum_approved,
             coalesce(sum(inv.outstanding),0)::int as sum_outstanding,
             coalesce(sum(inv.outstanding) filter (where inv.due_date is not null and inv.due_date < current_date),0)::int as sum_overdue,
             count(*) filter (where inv.outstanding > 0)::int as cnt_open
        from inv
       group by inv.sup_id
    )
    select s.id, s.name,
           coalesce(agg.sum_invoiced,0), coalesce(hold.sum_hold,0), coalesce(agg.sum_approved,0),
           coalesce(paid.sum_paid,0), coalesce(credited.sum_credited,0),
           coalesce(agg.sum_outstanding,0), coalesce(agg.sum_overdue,0),
           coalesce(agg.cnt_open,0), coalesce(hold.cnt_hold,0)
      from public.suppliers s
      left join agg on agg.sup_id = s.id
      left join hold on hold.sup_id = s.id
      left join paid on paid.sup_id = s.id
      left join credited on credited.sup_id = s.id
     where p_supplier_id is null or s.id = p_supplier_id
     order by coalesce(agg.sum_outstanding,0) desc;
end $fn$;
revoke all on function public.supplier_payable(uuid) from public;
grant execute on function public.supplier_payable(uuid) to authenticated, service_role;

-- Chronological statement (spec §23): invoices, credit notes and payments,
-- each signed so a running balance can be built by summing them in order.
create or replace function public.supplier_statement(p_supplier_id uuid, p_from date, p_to date)
returns table (txn_date date, kind text, reference text, amount_cents int, note text)
language plpgsql stable security definer set search_path = public, app as $fn$
begin
  if not (app.has_perm('payables.view') or app.has_perm('finance.view') or app.can_write()) then
    raise exception 'forbidden' using errcode = 'insufficient_privilege';
  end if;
  return query
    select si.invoice_date, 'invoice'::text, si.supplier_invoice_number, si.total_cents, si.notes
      from public.supplier_invoices si
     where si.supplier_id = p_supplier_id and si.status <> 'cancelled'
       and si.invoice_date >= p_from and si.invoice_date <= p_to
    union all
    select scn.credit_date, 'credit_note'::text, scn.reason, -scn.amount_cents, scn.reason
      from public.supplier_credit_notes scn
     where scn.supplier_id = p_supplier_id
       and scn.credit_date >= p_from and scn.credit_date <= p_to
    union all
    select sp.paid_at::date, 'payment'::text, coalesce(sp.reference, sp.method), -sp.amount_cents, sp.note
      from public.supplier_payments sp
     where sp.supplier_id = p_supplier_id
       and sp.paid_at::date >= p_from and sp.paid_at::date <= p_to
    order by 1;
end $fn$;
revoke all on function public.supplier_statement(uuid, date, date) from public;
grant execute on function public.supplier_statement(uuid, date, date) to authenticated, service_role;

-- ── AI Management: automatic low-stock supplier email ───────────────────
-- The trigger itself is deterministic SQL, not an AI decision — it must
-- keep working even if the AI model is unreachable (spec §22-23). AI's role
-- is limited to explaining this log when asked, never to deciding when to
-- fire it.
alter table public.inventory_items
  add column target_stock_qty numeric(14,3),   -- required for a reorder email to be eligible — never guessed
  add column auto_reorder_email boolean not null default true;  -- per-item opt-out

alter table public.purchasing_settings
  add column low_stock_email_enabled boolean not null default false;  -- restaurant-wide master switch, off by default

do $$ begin
  create type app.low_stock_event_status as enum ('open', 'resolved');
exception when duplicate_object then null; end $$;

-- At most one OPEN event per item at a time (the dedup guard, spec §2) —
-- enforced by the partial unique index below, not application logic.
create table public.low_stock_events (
  id                uuid primary key default gen_random_uuid(),
  inventory_item_id uuid not null references public.inventory_items(id) on delete cascade,
  status            app.low_stock_event_status not null default 'open',
  stock_at_open     numeric(14,3) not null,
  threshold_at_open numeric(14,3) not null,
  opened_at         timestamptz not null default now(),
  resolved_at       timestamptz
);
create unique index low_stock_events_one_open_idx on public.low_stock_events(inventory_item_id) where status = 'open';
create index low_stock_events_item_idx on public.low_stock_events(inventory_item_id, opened_at desc);
alter table public.low_stock_events enable row level security;
create policy staff_read on public.low_stock_events for select using (app.has_perm('stock.view') or app.is_staff());

-- Fires on every stock_qty/min_threshold change regardless of source (order
-- consumption, receiving, waste, adjustment, stock count) — opens a new
-- event only when none is already open, and resolves the open one the
-- moment stock rises back above threshold (spec §3). AFTER UPDATE only
-- (not INSERT), so a freshly created item at stock=0/threshold=0 never
-- fires before it has a real threshold configured.
create or replace function app.sync_low_stock_event() returns trigger
language plpgsql set search_path = public, app as $fn$
declare v_open_id uuid;
begin
  select id into v_open_id from public.low_stock_events
   where inventory_item_id = new.id and status = 'open';
  if new.stock_qty <= new.min_threshold then
    if v_open_id is null then
      insert into public.low_stock_events (inventory_item_id, stock_at_open, threshold_at_open)
      values (new.id, new.stock_qty, new.min_threshold);
    end if;
  elsif v_open_id is not null then
    update public.low_stock_events set status = 'resolved', resolved_at = now() where id = v_open_id;
  end if;
  return new;
end $fn$;
drop trigger if exists sync_low_stock_event on public.inventory_items;
create trigger sync_low_stock_event after update of stock_qty, min_threshold on public.inventory_items
  for each row execute function app.sync_low_stock_event();

-- The email log / supplier communication history (spec §13, §15, §19).
create table public.supplier_communications (
  id                 uuid primary key default gen_random_uuid(),
  supplier_id        uuid not null references public.suppliers(id) on delete cascade,
  inventory_item_id  uuid references public.inventory_items(id) on delete set null,
  low_stock_event_id uuid references public.low_stock_events(id) on delete set null,
  kind               text not null default 'low_stock_reorder' check (kind in ('low_stock_reorder')),
  subject            text not null,
  body               text not null,
  recipient_email    text not null,
  suggested_qty      numeric(14,3),
  status             text not null default 'pending' check (status in ('pending','sent','failed')),
  provider           text,
  error              text,
  sent_at            timestamptz,
  created_at         timestamptz not null default now()
);
create index supplier_communications_supplier_idx on public.supplier_communications(supplier_id, created_at desc);
create index supplier_communications_event_idx on public.supplier_communications(low_stock_event_id);
alter table public.supplier_communications enable row level security;
create policy staff_read on public.supplier_communications for select using (app.has_perm('payables.view') or app.has_perm('supplier.view') or app.is_staff());

-- The ONE authoritative eligibility query (spec §4, §24-25): open event,
-- restaurant automation on, item opted in, a real target stock configured
-- (never a guessed one), an active preferred supplier with a real email,
-- and — the actual dedup mechanism — no successful email already sent for
-- THIS event. apps/api's sweep calls this; nothing else decides eligibility.
create or replace function public.pending_low_stock_reorders()
returns table (
  low_stock_event_id uuid, inventory_item_id uuid, item_name text, unit text,
  stock_qty numeric, min_threshold numeric, target_stock_qty numeric, suggested_qty numeric,
  supplier_id uuid, supplier_name text, supplier_email text
)
language plpgsql stable security definer set search_path = public, app as $fn$
begin
  if not (app.has_perm('supplier.view') or app.can_write()) then
    raise exception 'forbidden' using errcode = 'insufficient_privilege';
  end if;
  return query
    select lse.id, ii.id, ii.name, ii.unit,
           ii.stock_qty, ii.min_threshold, ii.target_stock_qty,
           greatest(0, coalesce(ii.target_stock_qty, 0) - ii.stock_qty),
           s.id, s.name, s.email
      from public.low_stock_events lse
      join public.inventory_items ii on ii.id = lse.inventory_item_id
      join public.supplier_items si on si.inventory_item_id = ii.id and si.is_preferred and si.is_active
      join public.suppliers s on s.id = si.supplier_id and s.is_active
      cross join public.purchasing_settings ps
     where lse.status = 'open'
       and ii.auto_reorder_email
       and ps.low_stock_email_enabled
       and ii.target_stock_qty is not null
       and s.email is not null and s.email <> ''
       and not exists (
         select 1 from public.supplier_communications sc
          where sc.low_stock_event_id = lse.id and sc.status = 'sent'
       );
end $fn$;
revoke all on function public.pending_low_stock_reorders() from public;
grant execute on function public.pending_low_stock_reorders() to authenticated, service_role;

-- ── Shifts & attendance ──────────────────────────────────────────────────
create table public.shifts (
  id            uuid primary key default gen_random_uuid(),
  membership_id uuid not null references public.memberships(id) on delete cascade,
  starts_at     timestamptz not null,
  ends_at       timestamptz not null,
  role_label    text,
  notes         text,
  created_at    timestamptz not null default now(),
  check (ends_at > starts_at)
);
create index shifts_time_idx on public.shifts(starts_at);

create table public.attendance (
  id            uuid primary key default gen_random_uuid(),
  membership_id uuid not null references public.memberships(id) on delete cascade,
  business_date date,
  shift_id      uuid references public.shifts(id) on delete set null,
  clock_in      timestamptz,
  clock_out     timestamptz,
  status        text check (status in
                ('present','late','absent','half_day','leave','off','early_departure','incomplete')),
  late_minutes             int not null default 0,
  early_departure_minutes  int not null default 0,
  worked_minutes           int not null default 0,
  overtime_minutes         int not null default 0,
  overtime_approved_minutes int not null default 0,
  source        text not null default 'self' check (source in ('self','device','manager','auto')),
  portal_id     uuid,
  marked_by     uuid,
  note          text,
  created_at    timestamptz not null default now()
);
create index attendance_member_idx on public.attendance(membership_id, clock_in desc);
create unique index attendance_member_date_uq on public.attendance(membership_id, business_date);

-- ── Attendance & business settings (P6) ─────────────────────────────────
-- (public.business_settings is created earlier, ahead of Promotions — see
-- the comment there.)

create table public.attendance_settings (
  id                         boolean primary key default true check (id),
  grace_minutes              int not null default 10,
  standard_day_minutes       int not null default 480,
  working_days               int[] not null default '{1,2,3,4,5}',
  overtime_enabled           boolean not null default false,
  overtime_requires_approval boolean not null default true,
  auto_checkout              text not null default 'none' check (auto_checkout in ('none','shift_end')),
  target_pct                 numeric(5,2),
  band_excellent             int not null default 90,
  band_good                  int not null default 80,
  band_attention             int not null default 70
);
insert into public.attendance_settings (id) values (true);

alter table public.business_settings enable row level security;
alter table public.attendance_settings enable row level security;
create policy staff_read on public.business_settings for select using (app.has_perm('settings.view') or app.is_staff());
-- Writing business_settings includes the refund-approval-threshold
-- policy (tenant-migrations/0041) — deliberately requires explicit
-- settings.update rather than the usual can_write() manager-bypass, so
-- an unconfigured manager can't quietly raise/remove that limit.
create policy mgr_write  on public.business_settings for all using (app.has_perm('settings.update')) with check (app.has_perm('settings.update'));
create policy staff_read on public.attendance_settings for select using (app.has_perm('settings.view') or app.is_staff());
create policy mgr_write  on public.attendance_settings for all using (app.has_perm('settings.update') or app.can_write()) with check (app.has_perm('settings.update') or app.can_write());

alter table public.shifts enable row level security;
alter table public.attendance enable row level security;
create policy staff_read on public.shifts for select using (app.has_perm('attendance.view') or app.is_staff());
create policy mgr_write on public.shifts for all using (app.has_perm('attendance.mark') or app.can_write()) with check (app.has_perm('attendance.mark') or app.can_write());
-- staff with attendance.view see everyone; anyone sees their own row; writes via
-- the attendance_* RPCs (management still has a direct-write policy).
create policy staff_read on public.attendance for select using (
  app.has_perm('attendance.view') or app.is_staff() or membership_id = app.my_membership_id()
);
create policy mgr_write on public.attendance for all using (app.has_perm('attendance.mark') or app.can_write()) with check (app.has_perm('attendance.mark') or app.can_write());

-- ── Attendance helpers + RPCs (P6) ─────────────────────────────────────
create or replace function app.business_day(p_ts timestamptz default now())
returns date language sql stable set search_path = public, app as $fn$
  select ((p_ts at time zone (select timezone from public.business_settings where id))
          - make_interval(mins => (select business_day_start_minutes from public.business_settings where id)))::date
$fn$;

create or replace function app.recompute_attendance(p_id uuid)
returns void language plpgsql set search_path = public, app as $fn$
declare
  a public.attendance; s public.shifts; cfg public.attendance_settings; m public.memberships;
  v_worked int := 0; v_late int := 0; v_early int := 0; v_ot int := 0; v_status text;
  v_expected_start timestamptz; v_tz text;
begin
  select * into a from public.attendance where id = p_id;
  if not found then return; end if;
  select * into cfg from public.attendance_settings where id;
  select * into m from public.memberships where id = a.membership_id;
  select * into s from public.shifts
   where membership_id = a.membership_id and app.business_day(starts_at) = a.business_date
   order by starts_at limit 1;

  if a.clock_in is not null and a.clock_out is not null then
    v_worked := greatest(0, (extract(epoch from (a.clock_out - a.clock_in)) / 60)::int);
  end if;

  if s.id is not null then
    v_expected_start := s.starts_at;
  elsif m.shift_start_time is not null then
    -- No shift scheduled for this day — fall back to the member's own
    -- default start time (set at staff creation), interpreted in the
    -- restaurant's configured timezone, same zone app.business_day() uses.
    select timezone into v_tz from public.business_settings where id;
    v_expected_start := (a.business_date::timestamp + m.shift_start_time) at time zone coalesce(v_tz, 'UTC');
  end if;

  if v_expected_start is not null and a.clock_in is not null then
    v_late := greatest(0, (extract(epoch from (a.clock_in - v_expected_start)) / 60)::int - coalesce(cfg.grace_minutes, 0));
  end if;
  if s.id is not null and a.clock_out is not null then
    v_early := greatest(0, (extract(epoch from (s.ends_at - a.clock_out)) / 60)::int);
    if coalesce(cfg.overtime_enabled, false) then
      v_ot := greatest(0, (extract(epoch from (a.clock_out - s.ends_at)) / 60)::int);
    end if;
  end if;

  if a.status in ('absent', 'leave', 'off', 'half_day') then v_status := a.status;
  elsif a.clock_in is null then v_status := 'absent';
  elsif a.clock_out is null then v_status := 'incomplete';
  elsif v_late > 0 then v_status := 'late';
  elsif v_early > 0 then v_status := 'early_departure';
  else v_status := 'present';
  end if;

  update public.attendance
     set worked_minutes = v_worked, late_minutes = v_late, early_departure_minutes = v_early,
         overtime_minutes = v_ot, status = v_status, shift_id = s.id
   where id = p_id;
end $fn$;

create or replace function public.attendance_check_in(p_membership_id uuid default null)
returns public.attendance language plpgsql security definer set search_path = public, app as $fn$
declare v_mid uuid; v_date date := app.business_day(now()); v_row public.attendance; v_self boolean;
begin
  v_mid := coalesce(p_membership_id, app.my_membership_id());
  if v_mid is null then raise exception 'no_membership' using errcode = 'no_data_found'; end if;
  v_self := (v_mid = app.my_membership_id());
  if not (app.has_perm('attendance.check_in') or (v_self and app.has_perm('attendance.view_own'))) then
    raise exception 'forbidden' using errcode = 'insufficient_privilege';
  end if;
  select * into v_row from public.attendance where membership_id = v_mid and business_date = v_date;
  if found and v_row.clock_in is not null and v_row.clock_out is null then
    raise exception 'already_checked_in' using errcode = 'unique_violation';
  end if;
  if found then
    update public.attendance
       set clock_in = coalesce(clock_in, now()),
           source = case when app.current_portal_id() is not null then 'device' else 'self' end,
           portal_id = app.current_portal_id(), marked_by = app.jwt_sub()
     where id = v_row.id returning * into v_row;
  else
    insert into public.attendance (membership_id, business_date, clock_in, source, portal_id, marked_by, status)
    values (v_mid, v_date, now(),
            case when app.current_portal_id() is not null then 'device' else 'self' end,
            app.current_portal_id(), app.jwt_sub(), 'present')
    returning * into v_row;
  end if;
  perform app.recompute_attendance(v_row.id);
  perform app.log_action('attendance.check_in', 'attendance', v_row.id::text);
  select * into v_row from public.attendance where id = v_row.id;
  return v_row;
end $fn$;
revoke all on function public.attendance_check_in(uuid) from public;
grant execute on function public.attendance_check_in(uuid) to authenticated, service_role;

create or replace function public.attendance_check_out(p_membership_id uuid default null)
returns public.attendance language plpgsql security definer set search_path = public, app as $fn$
declare v_mid uuid; v_date date := app.business_day(now()); v_row public.attendance; v_self boolean;
begin
  v_mid := coalesce(p_membership_id, app.my_membership_id());
  if v_mid is null then raise exception 'no_membership' using errcode = 'no_data_found'; end if;
  v_self := (v_mid = app.my_membership_id());
  if not (app.has_perm('attendance.check_out') or (v_self and app.has_perm('attendance.view_own'))) then
    raise exception 'forbidden' using errcode = 'insufficient_privilege';
  end if;
  select * into v_row from public.attendance where membership_id = v_mid and business_date = v_date;
  if not found or v_row.clock_in is null then
    raise exception 'not_checked_in' using errcode = 'check_violation';
  end if;
  update public.attendance set clock_out = now() where id = v_row.id returning * into v_row;
  perform app.recompute_attendance(v_row.id);
  perform app.log_action('attendance.check_out', 'attendance', v_row.id::text);
  select * into v_row from public.attendance where id = v_row.id;
  return v_row;
end $fn$;
revoke all on function public.attendance_check_out(uuid) from public;
grant execute on function public.attendance_check_out(uuid) to authenticated, service_role;

create or replace function public.attendance_mark(
  p_membership_id uuid, p_business_date date, p_status text, p_note text default null
) returns void language plpgsql security definer set search_path = public, app as $fn$
begin
  if not app.has_perm('attendance.mark') then
    raise exception 'forbidden' using errcode = 'insufficient_privilege';
  end if;
  if p_status not in ('present','absent','late','half_day','leave','off','early_departure') then
    raise exception 'bad_status' using errcode = 'check_violation';
  end if;
  insert into public.attendance (membership_id, business_date, status, note, source, marked_by, portal_id)
  values (p_membership_id, p_business_date, p_status, p_note, 'manager', app.jwt_sub(), app.current_portal_id())
  on conflict (membership_id, business_date) do update
    set status = excluded.status, note = coalesce(excluded.note, public.attendance.note),
        source = 'manager', marked_by = excluded.marked_by;
  perform app.log_action('attendance.mark', 'attendance', p_membership_id::text, null,
                         jsonb_build_object('date', p_business_date, 'status', p_status));
end $fn$;
revoke all on function public.attendance_mark(uuid, date, text, text) from public;
grant execute on function public.attendance_mark(uuid, date, text, text) to authenticated, service_role;

create or replace function public.attendance_roster(p_date date default null)
returns table (membership_id uuid, full_name text, role text, status text,
               clock_in timestamptz, clock_out timestamptz, late_minutes int,
               shift_start_time time, expected_start timestamptz)
language plpgsql security definer set search_path = public, app as $fn$
declare v_date date := coalesce(p_date, app.business_day(now())); v_tz text;
begin
  if not (app.has_perm('attendance.view') or app.is_staff()) then
    raise exception 'forbidden' using errcode = 'insufficient_privilege';
  end if;
  select timezone into v_tz from public.business_settings where id;
  return query
    select m.id, m.full_name, m.role::text,
           coalesce(a.status, 'not_marked'), a.clock_in, a.clock_out, coalesce(a.late_minutes, 0),
           m.shift_start_time,
           coalesce(
             (select sh.starts_at from public.shifts sh
               where sh.membership_id = m.id and app.business_day(sh.starts_at) = v_date
               order by sh.starts_at limit 1),
             case when m.shift_start_time is not null
               then (v_date::timestamp + m.shift_start_time) at time zone coalesce(v_tz, 'UTC')
             end
           )
    from public.memberships m
    left join public.attendance a
      on a.membership_id = m.id and a.business_date = v_date
    where m.status = 'active'
    order by m.full_name nulls last;
end $fn$;
revoke all on function public.attendance_roster(date) from public;
grant execute on function public.attendance_roster(date) to authenticated, service_role;

-- ── Automatic absence marking (0053) — the 'auto' source value already
-- existed in attendance.source's check constraint, unused until now.
-- Called periodically per tenant by the API server (apps/api/src/lib/
-- attendanceAutomation.ts), same setInterval-sweep pattern low-stock/
-- recipe-cost automation already use — nothing here uses an AI model.
create or replace function public.attendance_auto_absent_sweep(p_lookback_days int default 3)
returns int language plpgsql security definer set search_path = public, app as $fn$
declare
  v_today date := app.business_day(now());
  v_marked int := 0;
  r record;
begin
  if not (app.jwt_role() = 'service_role' or app.has_perm('attendance.mark')) then
    raise exception 'forbidden' using errcode = 'insufficient_privilege';
  end if;

  for r in
    select m.id as membership_id, d.business_date
      from public.memberships m
      cross join lateral (
        select (v_today - g)::date as business_date
          from generate_series(1, greatest(p_lookback_days, 1)) as g
      ) d
     where m.status = 'active'
       and d.business_date < v_today
       and (
         -- Only ever auto-absent someone who was actually expected that
         -- day: an explicit shift, or a default shift_start_time on a day
         -- this restaurant normally schedules (attendance_settings.
         -- working_days) — never for someone never expected in.
         exists (
           select 1 from public.shifts sh
            where sh.membership_id = m.id and app.business_day(sh.starts_at) = d.business_date
         )
         or (
           m.shift_start_time is not null
           and extract(isodow from d.business_date)::int = any(
             select unnest(working_days) from public.attendance_settings where id
           )
         )
       )
       and not exists (
         select 1 from public.attendance a
          where a.membership_id = m.id and a.business_date = d.business_date
            and (a.clock_in is not null or a.status in ('absent', 'leave', 'off', 'half_day'))
       )
  loop
    insert into public.attendance (membership_id, business_date, status, source, marked_by)
    values (r.membership_id, r.business_date, 'absent', 'auto', null)
    on conflict (membership_id, business_date) do update
      set status = 'absent', source = 'auto'
      where public.attendance.clock_in is null
        and public.attendance.status not in ('leave', 'off', 'half_day');
    v_marked := v_marked + 1;
    perform app.log_action('attendance.auto_absent', 'attendance', r.membership_id::text, null,
      jsonb_build_object('business_date', r.business_date));
  end loop;

  return v_marked;
end $fn$;
revoke all on function public.attendance_auto_absent_sweep(int) from public;
grant execute on function public.attendance_auto_absent_sweep(int) to authenticated, service_role;

create or replace function public.attendance_month_summary(
  p_membership_id uuid, p_year int, p_month int
) returns jsonb language plpgsql security definer set search_path = public, app as $fn$
declare
  v_self boolean := (p_membership_id = app.my_membership_id());
  cfg public.attendance_settings;
  v_from date := make_date(p_year, p_month, 1);
  v_to date := (make_date(p_year, p_month, 1) + interval '1 month')::date;
  v_scheduled int; v_present int; v_absent int; v_late int; v_leave int; v_worked int; v_ot int;
begin
  if not (app.has_perm('attendance.view_reports') or app.has_perm('attendance.view_employee_reports')
          or (v_self and app.has_perm('attendance.view_own'))) then
    raise exception 'forbidden' using errcode = 'insufficient_privilege';
  end if;
  select * into cfg from public.attendance_settings where id;
  select count(*) into v_scheduled
  from generate_series(v_from, v_to - 1, interval '1 day') d
  where extract(isodow from d)::int = any(cfg.working_days);
  select
    count(*) filter (where status in ('present','late','early_departure','half_day')),
    count(*) filter (where status = 'absent'),
    count(*) filter (where status = 'late'),
    count(*) filter (where status = 'leave'),
    coalesce(sum(worked_minutes), 0), coalesce(sum(overtime_approved_minutes), 0)
  into v_present, v_absent, v_late, v_leave, v_worked, v_ot
  from public.attendance
  where membership_id = p_membership_id and business_date >= v_from and business_date < v_to;
  return jsonb_build_object(
    'scheduled_days', v_scheduled, 'present', v_present, 'absent', v_absent, 'late', v_late, 'leave', v_leave,
    'worked_minutes', v_worked, 'approved_overtime_minutes', v_ot,
    'attendance_pct', case when v_scheduled - v_leave > 0 then round(v_present::numeric * 100 / (v_scheduled - v_leave), 1) end,
    'punctuality_pct', case when v_present > 0 then round((v_present - v_late)::numeric * 100 / v_present, 1) end,
    'bands', jsonb_build_object('excellent', cfg.band_excellent, 'good', cfg.band_good, 'attention', cfg.band_attention)
  );
end $fn$;
revoke all on function public.attendance_month_summary(uuid, int, int) from public;
grant execute on function public.attendance_month_summary(uuid, int, int) to authenticated, service_role;

-- ── Audit log ────────────────────────────────────────────────────────────
create table public.audit_logs (
  id          bigint generated always as identity primary key,
  actor_id    uuid,
  actor_email text,
  actor_role  text,
  portal_id   uuid,            -- portal the change was made from (P8)
  action      text not null,   -- INSERT | UPDATE | DELETE | domain verb
  entity      text not null,   -- table name
  entity_id   text,
  before      jsonb,
  after       jsonb,
  created_at  timestamptz not null default now()
);
create index audit_logs_created_idx on public.audit_logs(created_at desc);
create index audit_logs_entity_idx on public.audit_logs(entity, created_at desc);

alter table public.audit_logs enable row level security;
create policy mgr_read on public.audit_logs for select using (app.can_write());

create or replace function app.audit_row() returns trigger
language plpgsql security definer set search_path = public, app as $fn$
declare
  v_claims jsonb := nullif(current_setting('request.jwt.claims', true), '')::jsonb;
begin
  insert into public.audit_logs (
    actor_id, actor_email, actor_role, portal_id, action, entity, entity_id, before, after
  ) values (
    (v_claims #>> '{sub}')::uuid,
    v_claims #>> '{email}',
    app.current_member_role(),
    app.current_portal_id(),
    tg_op,
    tg_table_name,
    coalesce(to_jsonb(new) ->> 'id', to_jsonb(old) ->> 'id'),
    case when tg_op in ('UPDATE', 'DELETE') then to_jsonb(old) end,
    case when tg_op in ('UPDATE', 'INSERT') then to_jsonb(new) end
  );
  return coalesce(new, old);
end $fn$;

-- Targeted order-lifecycle audit: create + meaningful status/payment/total
-- changes only (not the KDS line-status churn).
create or replace function app.audit_order() returns trigger
language plpgsql security definer set search_path = public, app as $fn$
begin
  if tg_op = 'INSERT' then
    perform app.log_action('order.created', 'orders', new.id::text, null,
      jsonb_build_object('order_number', new.order_number, 'status', new.status));
  elsif tg_op = 'UPDATE' and (
      new.status is distinct from old.status
      or new.payment_method is distinct from old.payment_method
      or (new.paid_at is null) is distinct from (old.paid_at is null)
      or new.total_cents is distinct from old.total_cents
      or coalesce(new.refunded_cents, 0) is distinct from coalesce(old.refunded_cents, 0)
  ) then
    perform app.log_action('order.updated', 'orders', new.id::text,
      jsonb_build_object('status', old.status, 'total_cents', old.total_cents,
                         'payment_method', old.payment_method, 'refunded_cents', old.refunded_cents),
      jsonb_build_object('status', new.status, 'total_cents', new.total_cents,
                         'payment_method', new.payment_method, 'refunded_cents', new.refunded_cents));
  end if;
  return coalesce(new, old);
end $fn$;
create trigger audit_order after insert or update on public.orders
  for each row execute function app.audit_order();

-- ── AI Approval Inbox ─────────────────────────────────────────────────────
-- Persists every AI-proposed action (not just the one that happens to be
-- confirmed inline, same chat, same session) so a "sensitive action"
-- proposal is visible to any authorized approver, not lost the moment the
-- proposing chat tab closes. Writes go through the tenant admin client
-- (same as every other AI route) — RLS here is a defense-in-depth
-- backstop, not the primary gate; the real permission checks live in
-- Express (requirePortalPerm + permits(), matching every other AI route).
create type app.ai_pending_action_status as enum ('pending', 'approved', 'rejected', 'expired', 'failed');

create table public.ai_pending_actions (
  id                 uuid primary key default gen_random_uuid(),
  action_name        text not null,
  args               jsonb not null,
  summary            text not null,
  status             app.ai_pending_action_status not null default 'pending',
  proposed_by        uuid,
  proposed_by_email  text,
  proposed_by_role   text,
  created_at         timestamptz not null default now(),
  resolved_at        timestamptz,
  resolved_by        uuid,
  resolved_by_email  text,
  result             jsonb,
  error              text
);
create index ai_pending_actions_status_idx on public.ai_pending_actions(status, created_at desc);

alter table public.ai_pending_actions enable row level security;
create policy staff_read on public.ai_pending_actions for select
  using (app.has_perm('ai.execute_write') or app.has_perm('ai.approve_sensitive_action') or app.can_write());
create policy mgr_write on public.ai_pending_actions for all
  using (app.has_perm('ai.execute_write') or app.has_perm('ai.approve_sensitive_action') or app.can_write())
  with check (app.has_perm('ai.execute_write') or app.has_perm('ai.approve_sensitive_action') or app.can_write());

-- ── Exception lifecycle state ─────────────────────────────────────────────
-- computeAttentionItems() (the Exception Center / AI's own "what needs my
-- attention") is deliberately stateless — it recomputes fresh every call,
-- which is exactly right for detecting a problem, but gives a manager no
-- way to note "seen this, handling it" without the exact same message
-- reappearing as if untouched. An exception has no natural row of its own
-- to attach state to (it's a computed fact, not a table), so the state is
-- keyed on the exact "category::message" text the item itself carries —
-- the moment the underlying condition changes even slightly (stock moves
-- further, a hold gets a new reason), that's a materially different
-- exception and correctly starts unacknowledged again, matching spec
-- intent ("notify again when the condition changes") without any separate
-- fingerprinting scheme to keep in sync.
create type app.exception_state_status as enum ('acknowledged', 'resolved', 'ignored');

create table public.exception_states (
  fingerprint  text primary key,
  status       app.exception_state_status not null,
  note         text,
  actor_id     uuid,
  actor_email  text,
  actor_role   text,
  updated_at   timestamptz not null default now()
);

alter table public.exception_states enable row level security;
create policy staff_read on public.exception_states for select using (app.has_perm('orders.view') or app.is_staff());
create policy mgr_write on public.exception_states for all
  using (app.has_perm('orders.view') or app.can_write())
  with check (app.has_perm('orders.view') or app.can_write());

-- ── Daily closing (P8) ───────────────────────────────────────────────────
create table public.daily_closings (
  id                 uuid primary key default gen_random_uuid(),
  business_date      date not null unique,
  status             text not null default 'open' check (status in ('open','closed')),
  opening_cash_cents int not null default 0,
  closing_cash_cents int,
  expected_cash_cents int,
  difference_cents   int,
  gross_sales_cents  int not null default 0,
  discounts_cents    int not null default 0,
  refunds_cents      int not null default 0,
  net_sales_cents    int not null default 0,
  order_count        int not null default 0,
  note               text,
  closed_by          uuid,
  closed_at          timestamptz,
  reopened_by        uuid,
  reopened_at        timestamptz,
  created_at         timestamptz not null default now()
);
alter table public.daily_closings enable row level security;
create policy staff_read on public.daily_closings for select using (app.has_perm('finance.view') or app.is_staff());

create or replace function app.day_sales(p_date date)
returns jsonb language sql stable set search_path = public, app as $fn$
  with o as (
    select * from public.orders
    where status in ('served','paid') and app.business_day(coalesce(paid_at, created_at)) = p_date
  )
  select jsonb_build_object(
    'gross_sales_cents', coalesce((select sum(subtotal_cents) from o), 0),
    'discounts_cents',   coalesce((select sum(discount_cents) from o), 0),
    'refunds_cents',     coalesce((select sum(refunded_cents) from o), 0),
    'net_sales_cents',   coalesce((select sum(subtotal_cents - discount_cents - coalesce(refunded_cents,0)) from o), 0),
    'order_count',       (select count(*) from o),
    'cash_in_cents',     coalesce((select sum(p.amount_cents - p.refunded_cents)
                                   from public.payments p join o on o.id = p.order_id
                                   where p.status <> 'voided' and p.method = 'cash'), 0)
  )
$fn$;

create or replace function public.close_business_day(
  p_business_date date, p_opening_cash int default 0,
  p_closing_cash int default null, p_note text default null
) returns public.daily_closings
language plpgsql security definer set search_path = public, app as $fn$
declare v_s jsonb; v_expected int; v_diff int; v_row public.daily_closings;
begin
  if not app.has_perm('finance.close_day') then
    raise exception 'forbidden' using errcode = 'insufficient_privilege';
  end if;
  v_s := app.day_sales(p_business_date);
  v_expected := coalesce(p_opening_cash, 0) + (v_s->>'cash_in_cents')::int;
  v_diff := case when p_closing_cash is null then null else p_closing_cash - v_expected end;

  insert into public.daily_closings (
    business_date, status, opening_cash_cents, closing_cash_cents, expected_cash_cents,
    difference_cents, gross_sales_cents, discounts_cents, refunds_cents, net_sales_cents,
    order_count, note, closed_by, closed_at
  ) values (
    p_business_date, 'closed', coalesce(p_opening_cash, 0), p_closing_cash, v_expected, v_diff,
    (v_s->>'gross_sales_cents')::int, (v_s->>'discounts_cents')::int, (v_s->>'refunds_cents')::int,
    (v_s->>'net_sales_cents')::int, (v_s->>'order_count')::int, p_note, app.jwt_sub(), now()
  )
  on conflict (business_date) do update set
    status = 'closed', opening_cash_cents = excluded.opening_cash_cents,
    closing_cash_cents = excluded.closing_cash_cents, expected_cash_cents = excluded.expected_cash_cents,
    difference_cents = excluded.difference_cents, gross_sales_cents = excluded.gross_sales_cents,
    discounts_cents = excluded.discounts_cents, refunds_cents = excluded.refunds_cents,
    net_sales_cents = excluded.net_sales_cents, order_count = excluded.order_count,
    note = coalesce(excluded.note, public.daily_closings.note),
    closed_by = excluded.closed_by, closed_at = now()
  returning * into v_row;

  perform app.log_action('day.closed', 'daily_closings', p_business_date::text, null, to_jsonb(v_row));
  return v_row;
end $fn$;
revoke all on function public.close_business_day(date, int, int, text) from public;
grant execute on function public.close_business_day(date, int, int, text) to authenticated, service_role;

create or replace function public.reopen_business_day(p_business_date date, p_reason text)
returns void language plpgsql security definer set search_path = public, app as $fn$
begin
  if not app.has_perm('finance.reopen_day') then
    raise exception 'forbidden' using errcode = 'insufficient_privilege';
  end if;
  update public.daily_closings
     set status = 'open', reopened_by = app.jwt_sub(), reopened_at = now(),
         note = coalesce(nullif(trim(p_reason), ''), note)
   where business_date = p_business_date;
  if not found then raise exception 'not_found' using errcode = 'no_data_found'; end if;
  perform app.log_action('day.reopened', 'daily_closings', p_business_date::text, null,
                         jsonb_build_object('reason', p_reason));
end $fn$;
revoke all on function public.reopen_business_day(date, text) from public;
grant execute on function public.reopen_business_day(date, text) to authenticated, service_role;

-- ── Dashboard sales trend (visual dashboard spec §5-9) ──────────────────────
-- One row per real business day (never a future date, never a manufactured
-- one — spec §34), built on app.day_sales() so the trend line, the daily
-- closing report and any other surface agree on what "today's sales" means.
create or replace function public.sales_by_day(p_from date, p_to date)
returns table (
  business_date date, gross_sales_cents int, discount_cents int,
  refunded_cents int, net_sales_cents int, orders_count int
)
language plpgsql stable security definer set search_path = public, app as $fn$
begin
  if not (app.has_perm('orders.view') or app.is_staff()) then
    raise exception 'forbidden' using errcode = 'insufficient_privilege';
  end if;
  return query
    select d.day::date,
           (x.s->>'gross_sales_cents')::int, (x.s->>'discounts_cents')::int,
           (x.s->>'refunds_cents')::int, (x.s->>'net_sales_cents')::int, (x.s->>'order_count')::int
      from generate_series(p_from::timestamp, least(p_to, current_date)::timestamp, interval '1 day') as d(day),
           lateral (select app.day_sales(d.day::date) as s) x
     order by d.day;
end $fn$;
revoke all on function public.sales_by_day(date, date) from public;
grant execute on function public.sales_by_day(date, date) to authenticated, service_role;

-- Hourly breakdown for one business day — the drill-down behind the trend
-- line's day picker. Every hour 0-23 is returned (0 sales renders as a real
-- gap in the bar chart, not a missing bar) in the restaurant's own timezone.
create or replace function public.sales_by_hour(p_date date)
returns table (hour_of_day int, net_sales_cents int, orders_count int)
language plpgsql stable security definer set search_path = public, app as $fn$
begin
  if not (app.has_perm('orders.view') or app.is_staff()) then
    raise exception 'forbidden' using errcode = 'insufficient_privilege';
  end if;
  return query
    select h.hr,
           coalesce(sum(o.subtotal_cents - o.discount_cents - coalesce(o.refunded_cents,0)) filter (where o.id is not null), 0)::int,
           count(o.id)::int
      from generate_series(0, 23) as h(hr)
      left join public.orders o
        on o.status in ('served','paid')
       and app.business_day(coalesce(o.paid_at, o.created_at)) = p_date
       and extract(hour from (coalesce(o.paid_at, o.created_at)
             at time zone coalesce((select timezone from public.business_settings where id), 'UTC'))) = h.hr
     group by h.hr
     order by h.hr;
end $fn$;
revoke all on function public.sales_by_hour(date) from public;
grant execute on function public.sales_by_hour(date) to authenticated, service_role;

-- The "underlying orders" step of the Month -> Day -> hourly -> orders
-- drill-down, same business-day population as the two functions above.
create or replace function public.orders_on_day(p_date date)
returns table (
  order_id uuid, order_number bigint, status text, channel text, table_label text,
  total_cents int, discount_cents int, event_at timestamptz
)
language plpgsql stable security definer set search_path = public, app as $fn$
begin
  if not (app.has_perm('orders.view') or app.is_staff()) then
    raise exception 'forbidden' using errcode = 'insufficient_privilege';
  end if;
  return query
    select o.id, o.order_number, o.status::text, o.channel::text, o.table_label,
           o.total_cents, o.discount_cents, coalesce(o.paid_at, o.created_at)
      from public.orders o
     where o.status in ('served','paid')
       and app.business_day(coalesce(o.paid_at, o.created_at)) = p_date
     order by coalesce(o.paid_at, o.created_at);
end $fn$;
revoke all on function public.orders_on_day(date) from public;
grant execute on function public.orders_on_day(date) to authenticated, service_role;

-- Revenue by menu category, à la carte lines only (same simplification as
-- item_profitability — a deal's revenue is costed/reported as the deal, not
-- split across its components' categories). Feeds the dashboard's revenue-
-- mix pie chart.
create or replace function public.revenue_by_category(p_from timestamptz, p_to timestamptz)
returns table (category_id uuid, category_name text, revenue_cents int, qty_sold int)
language plpgsql stable security definer set search_path = public, app as $fn$
begin
  if not (app.has_perm('orders.view') or app.is_staff()) then
    raise exception 'forbidden' using errcode = 'insufficient_privilege';
  end if;
  return query
    select coalesce(mc.id, '00000000-0000-0000-0000-000000000000'::uuid) as cat_id,
           coalesce(mc.name, 'Uncategorized') as cat_name,
           sum(l.line_total_cents)::int as cat_revenue,
           sum(l.qty)::int as cat_qty
      from public.order_lines l
      join public.orders o on o.id = l.order_id
      left join public.menu_items mi on mi.id = l.menu_item_id
      left join public.menu_categories mc on mc.id = mi.category_id
     where l.deal_id is null and l.menu_item_id is not null
       and o.status in ('served','paid')
       and coalesce(o.paid_at, o.created_at) >= p_from and coalesce(o.paid_at, o.created_at) < p_to
     group by mc.id, mc.name
     order by sum(l.line_total_cents) desc;
end $fn$;
revoke all on function public.revenue_by_category(timestamptz, timestamptz) from public;
grant execute on function public.revenue_by_category(timestamptz, timestamptz) to authenticated, service_role;

-- Payment method mix for the dashboard's payment-mix pie chart.
create or replace function public.payment_mix(p_from timestamptz, p_to timestamptz)
returns table (method text, revenue_cents int, orders_count int)
language plpgsql stable security definer set search_path = public, app as $fn$
begin
  if not (app.has_perm('orders.view') or app.is_staff()) then
    raise exception 'forbidden' using errcode = 'insufficient_privilege';
  end if;
  return query
    select coalesce(o.payment_method, 'unknown') as pm,
           sum(o.total_cents)::int as pm_revenue,
           count(*)::int as pm_count
      from public.orders o
     where o.status = 'paid'
       and o.paid_at >= p_from and o.paid_at < p_to
     group by coalesce(o.payment_method, 'unknown')
     order by sum(o.total_cents) desc;
end $fn$;
revoke all on function public.payment_mix(timestamptz, timestamptz) from public;
grant execute on function public.payment_mix(timestamptz, timestamptz) to authenticated, service_role;

-- Customer experience averages for the dashboard (spec §12) — category
-- ratings are optional per submission, so each average is over whatever
-- guests actually rated for that category, not the full response count.
create or replace function public.feedback_summary(p_from timestamptz, p_to timestamptz)
returns table (
  responses int, avg_overall numeric, avg_food numeric, avg_service numeric,
  avg_cleanliness numeric, avg_speed numeric, avg_ambiance numeric
)
language plpgsql stable security definer set search_path = public, app as $fn$
begin
  if not (app.has_perm('orders.view') or app.is_staff()) then
    raise exception 'forbidden' using errcode = 'insufficient_privilege';
  end if;
  return query
    select count(*)::int,
           round(avg(f.overall)::numeric, 2),
           round(avg(f.food)::numeric, 2),
           round(avg(f.service)::numeric, 2),
           round(avg(f.cleanliness)::numeric, 2),
           round(avg(f.speed)::numeric, 2),
           round(avg(f.ambiance)::numeric, 2)
      from public.feedback f
     where f.created_at >= p_from and f.created_at < p_to;
end $fn$;
revoke all on function public.feedback_summary(timestamptz, timestamptz) from public;
grant execute on function public.feedback_summary(timestamptz, timestamptz) to authenticated, service_role;

-- ── Operating expenses (spec §28-29 — Prime Cost / Net Profit inputs) ──────
-- Deliberately simple: a category + amount + date. Payroll/labor stays out
-- of scope here (spec §28 — no arbitrary per-order salary allocation); this
-- exists so period_profitability() can reach real Net Profit, not stop at
-- Contribution/Gross Profit.
create table public.expenses (
  id           uuid primary key default gen_random_uuid(),
  category     text not null,
  description  text,
  amount_cents int not null check (amount_cents > 0),
  expense_date date not null default current_date,
  recorded_by  uuid,
  -- Which supplier this was actually paid to (0045) — optional, most
  -- categories (Rent/Utilities/Labor) have none.
  supplier_id  uuid references public.suppliers(id) on delete set null,
  created_at   timestamptz not null default now()
);
create index expenses_date_idx on public.expenses(expense_date desc);
alter table public.expenses enable row level security;
-- Finance domain (same narrow exception as payments/refunds above): no
-- is_staff()/can_write() fallback, so expense records stay invisible to
-- a manager until the Owner explicitly grants finance.*.
create policy staff_read on public.expenses for select using (app.has_perm('finance.view'));
create policy staff_insert on public.expenses for insert with check (app.has_perm('finance.create_expense'));
create policy staff_update on public.expenses for update using (app.has_perm('finance.update_expense')) with check (app.has_perm('finance.update_expense'));
create policy staff_delete on public.expenses for delete using (app.has_perm('finance.delete_expense'));
create trigger audit after insert or update or delete on public.expenses for each row execute function app.audit_row();

-- ── COGS & Profitability engine (recipe/inventory/costing spec §22-31, §49) ─
-- ONE authoritative calculation layer: the Finance page, the AI assistant,
-- and any future report all call these same functions rather than each
-- re-deriving gross/net/COGS/contribution with their own formula. Every
-- number a caller can't get honestly (e.g. no recipe cost configured) comes
-- back as null / a missing-lines count, never a guessed value (spec §64-65).
--
-- "Net sales" is always subtotal (gross) minus discount minus refunds —
-- never gross alone (spec §23, §57 discount test). A deal's revenue is its
-- own line_total_cents (the deal price actually charged), never the sum of
-- component list prices (spec §15, §56 deal test) — that falls out for free
-- because place_order() already prices deal components at zero and puts the
-- deal price on the header line alone.
--
-- Theoretical vs Actual COGS (spec §30) is read straight off the ledger
-- rather than reconstructed from historical stock balances: every ledger
-- row now carries the cost basis it was valued at (unit_cost_cents_base,
-- above), so "actual" ingredient value consumed/wasted/adjusted in a period
-- is a straight sum, and the gap against the recipe-driven theoretical COGS
-- is exactly the waste + shrinkage the period actually saw.

create or replace function public.order_profitability(p_order_id uuid)
returns table (
  order_id uuid, order_number bigint, status text,
  gross_sales_cents int, discount_cents int, refunded_cents int, tax_cents int,
  net_sales_cents int, cogs_cents int, cogs_lines_total int, cogs_lines_missing int,
  food_cost_pct numeric, contribution_cents int, contribution_margin_pct numeric
)
language plpgsql stable security definer set search_path = public, app as $fn$
begin
  if not (app.has_perm('finance.view_profit') or app.has_perm('finance.view_cogs') or app.has_perm('inventory.view_cost')) then
    raise exception 'forbidden' using errcode = 'insufficient_privilege';
  end if;
  return query
    with base as (
      select o.id, o.order_number, o.status::text as status,
             o.subtotal_cents as gross_sales_cents, o.discount_cents,
             coalesce(o.refunded_cents,0) as refunded_cents, o.tax_cents,
             (o.subtotal_cents - o.discount_cents - coalesce(o.refunded_cents,0)) as net_sales_cents
        from public.orders o where o.id = p_order_id
    ),
    agg as (
      select coalesce(sum(ol.recipe_cost_cents),0)::int as cogs_cents,
             count(*)::int as lines_total,
             count(*) filter (where ol.recipe_cost_cents is null)::int as lines_missing
        from public.order_lines ol where ol.order_id = p_order_id
    )
    select base.id, base.order_number, base.status,
           base.gross_sales_cents, base.discount_cents, base.refunded_cents, base.tax_cents,
           base.net_sales_cents, agg.cogs_cents, agg.lines_total, agg.lines_missing,
           case when base.net_sales_cents > 0 then round(agg.cogs_cents::numeric / base.net_sales_cents * 1000) / 10 else null end,
           (base.net_sales_cents - agg.cogs_cents),
           case when base.net_sales_cents > 0 then round((base.net_sales_cents - agg.cogs_cents)::numeric / base.net_sales_cents * 1000) / 10 else null end
      from base, agg;
end $fn$;
revoke all on function public.order_profitability(uuid) from public;
grant execute on function public.order_profitability(uuid) to authenticated, service_role;

-- A "sale" for period_profitability/item_profitability/deal_profitability is
-- the same population daily-closing already uses (app.day_sales): status
-- served or paid, bucketed by paid_at (or created_at if never paid) — the
-- one existing authoritative definition of "this counts as a sale", not a
-- second competing one.
create or replace function public.period_profitability(p_from timestamptz, p_to timestamptz)
returns table (
  from_ts timestamptz, to_ts timestamptz,
  orders_count int, gross_sales_cents int, discount_cents int, refunded_cents int,
  net_sales_cents int, avg_order_cents int,
  theoretical_cogs_cents int, cogs_lines_total int, cogs_lines_missing int,
  gross_profit_cents int, gross_margin_pct numeric, food_cost_pct numeric,
  consumption_ledger_cents int, waste_cents int, net_adjustment_cents int,
  actual_cogs_cents int, cogs_variance_cents int,
  expenses_cents int, net_profit_cents int, net_profit_margin_pct numeric
)
language plpgsql stable security definer set search_path = public, app as $fn$
begin
  if not (app.has_perm('finance.view_profit') or app.has_perm('finance.view_cogs') or app.has_perm('inventory.view_cost')) then
    raise exception 'forbidden' using errcode = 'insufficient_privilege';
  end if;
  return query
    with sales as (
      select o.id, o.subtotal_cents, o.discount_cents, coalesce(o.refunded_cents,0) as refunded_cents
        from public.orders o
       where o.status in ('served','paid')
         and coalesce(o.paid_at, o.created_at) >= p_from and coalesce(o.paid_at, o.created_at) < p_to
    ),
    sales_agg as (
      select count(*)::int as orders_count,
             coalesce(sum(sales.subtotal_cents),0)::int as gross_sales_cents,
             coalesce(sum(sales.discount_cents),0)::int as discount_cents,
             coalesce(sum(sales.refunded_cents),0)::int as refunded_cents,
             coalesce(sum(sales.subtotal_cents - sales.discount_cents - sales.refunded_cents),0)::int as net_sales_cents
        from sales
    ),
    cogs_agg as (
      select coalesce(sum(l.recipe_cost_cents),0)::int as cogs_cents,
             count(*)::int as lines_total,
             count(*) filter (where l.recipe_cost_cents is null)::int as lines_missing
        from public.order_lines l join sales s on s.id = l.order_id
    ),
    -- Actual ingredient value moved in the period, read off the ledger's own
    -- cost-basis snapshot (unit_cost_cents_base) rather than recomputed.
    ledger_agg as (
      select
        coalesce(sum(abs(delta_qty * unit_cost_cents_base)) filter (where reason = 'order_deduction'), 0)::int as consumption_cents,
        coalesce(sum(abs(delta_qty * unit_cost_cents_base)) filter (where reason = 'spoilage'), 0)::int as waste_cents,
        coalesce(sum(delta_qty * unit_cost_cents_base) filter (where reason in ('adjustment','stock_take')), 0)::int as net_adjustment_cents
        from public.stock_ledger
       where created_at >= p_from and created_at < p_to and unit_cost_cents_base is not null
    ),
    exp_agg as (
      -- expense_date is a plain date (no time-of-day); the upper bound is
      -- inclusive so an expense dated "today" is still counted when p_to is
      -- "now" — a strict "<" against a date-truncated timestamptz would
      -- otherwise drop every expense recorded earlier today.
      select coalesce(sum(amount_cents),0)::int as expenses_cents
        from public.expenses
       where expense_date >= p_from::date and expense_date <= p_to::date
    )
    select
      p_from, p_to,
      sales_agg.orders_count, sales_agg.gross_sales_cents, sales_agg.discount_cents, sales_agg.refunded_cents,
      sales_agg.net_sales_cents,
      case when sales_agg.orders_count > 0 then round(sales_agg.net_sales_cents::numeric / sales_agg.orders_count)::int else 0 end,
      cogs_agg.cogs_cents, cogs_agg.lines_total, cogs_agg.lines_missing,
      (sales_agg.net_sales_cents - cogs_agg.cogs_cents),
      case when sales_agg.net_sales_cents > 0 then round((sales_agg.net_sales_cents - cogs_agg.cogs_cents)::numeric / sales_agg.net_sales_cents * 1000) / 10 else null end,
      case when sales_agg.net_sales_cents > 0 then round(cogs_agg.cogs_cents::numeric / sales_agg.net_sales_cents * 1000) / 10 else null end,
      ledger_agg.consumption_cents, ledger_agg.waste_cents, ledger_agg.net_adjustment_cents,
      (ledger_agg.consumption_cents + ledger_agg.waste_cents - ledger_agg.net_adjustment_cents),
      (ledger_agg.consumption_cents + ledger_agg.waste_cents - ledger_agg.net_adjustment_cents - cogs_agg.cogs_cents),
      exp_agg.expenses_cents,
      (sales_agg.net_sales_cents - cogs_agg.cogs_cents - exp_agg.expenses_cents),
      case when sales_agg.net_sales_cents > 0 then round((sales_agg.net_sales_cents - cogs_agg.cogs_cents - exp_agg.expenses_cents)::numeric / sales_agg.net_sales_cents * 1000) / 10 else null end
      from sales_agg, cogs_agg, ledger_agg, exp_agg;
end $fn$;
revoke all on function public.period_profitability(timestamptz, timestamptz) from public;
grant execute on function public.period_profitability(timestamptz, timestamptz) to authenticated, service_role;

-- Per menu item/variant, à la carte lines only (deal_id is null) — a deal's
-- own components are costed as part of the deal, not folded into the item's
-- own numbers here (spec §31 menu engineering needs "this item sold alone").
create or replace function public.item_profitability(p_from timestamptz, p_to timestamptz)
returns table (
  menu_item_id uuid, variant_id uuid, name text,
  qty_sold int, revenue_cents int, cogs_cents int, cogs_known boolean,
  contribution_cents int, contribution_margin_pct numeric, food_cost_pct numeric
)
language plpgsql stable security definer set search_path = public, app as $fn$
begin
  if not (app.has_perm('finance.view_profit') or app.has_perm('finance.view_cogs') or app.has_perm('inventory.view_cost')) then
    raise exception 'forbidden' using errcode = 'insufficient_privilege';
  end if;
  return query
    select
      l.menu_item_id, l.variant_id, max(l.name_snapshot) as name,
      sum(l.qty)::int as qty_sold, sum(l.line_total_cents)::int as revenue_cents,
      coalesce(sum(l.recipe_cost_cents),0)::int as cogs_cents,
      bool_and(l.recipe_cost_cents is not null) as cogs_known,
      (sum(l.line_total_cents) - coalesce(sum(l.recipe_cost_cents),0))::int as contribution_cents,
      case when sum(l.line_total_cents) > 0
        then round((sum(l.line_total_cents) - coalesce(sum(l.recipe_cost_cents),0))::numeric / sum(l.line_total_cents) * 1000) / 10
        else null end as contribution_margin_pct,
      case when sum(l.line_total_cents) > 0
        then round(coalesce(sum(l.recipe_cost_cents),0)::numeric / sum(l.line_total_cents) * 1000) / 10
        else null end as food_cost_pct
      from public.order_lines l
      join public.orders o on o.id = l.order_id
     where l.deal_id is null and l.menu_item_id is not null
       and o.status in ('served','paid')
       and coalesce(o.paid_at, o.created_at) >= p_from and coalesce(o.paid_at, o.created_at) < p_to
     group by l.menu_item_id, l.variant_id
     order by revenue_cents desc;
end $fn$;
revoke all on function public.item_profitability(timestamptz, timestamptz) from public;
grant execute on function public.item_profitability(timestamptz, timestamptz) to authenticated, service_role;

-- Per deal: header line(s) for revenue, that same (order_id, deal_id)'s
-- component lines for COGS (spec §15, §56). list_value_cents/
-- customer_saving_cents use TODAY's component menu prices — an operational
-- estimate, since a component's list price isn't snapshotted per historical
-- sale the way revenue and COGS are.
create or replace function public.deal_profitability(p_from timestamptz, p_to timestamptz)
returns table (
  deal_id uuid, name text, qty_sold int, revenue_cents int, cogs_cents int, cogs_known boolean,
  contribution_cents int, contribution_margin_pct numeric, food_cost_pct numeric,
  list_value_cents int, customer_saving_cents int
)
language plpgsql stable security definer set search_path = public, app as $fn$
begin
  if not (app.has_perm('finance.view_profit') or app.has_perm('finance.view_cogs') or app.has_perm('inventory.view_cost')) then
    raise exception 'forbidden' using errcode = 'insufficient_privilege';
  end if;
  return query
    with header as (
      select l.order_id, l.deal_id, l.name_snapshot as name, l.qty, l.line_total_cents
        from public.order_lines l
        join public.orders o on o.id = l.order_id
       where l.deal_id is not null and l.menu_item_id is null
         and o.status in ('served','paid')
         and coalesce(o.paid_at, o.created_at) >= p_from and coalesce(o.paid_at, o.created_at) < p_to
    ),
    comp as (
      select ol.order_id, ol.deal_id,
             coalesce(sum(ol.recipe_cost_cents),0)::int as cogs_cents,
             bool_and(ol.recipe_cost_cents is not null) as cogs_known
        from public.order_lines ol
       where ol.deal_id is not null and ol.menu_item_id is not null
       group by ol.order_id, ol.deal_id
    ),
    list_price as (
      select dc.deal_id, sum(dc.qty * coalesce(v.price_cents, mi.price_cents, 0))::int as list_value_cents
        from public.deal_components dc
        join public.menu_items mi on mi.id = dc.menu_item_id
        left join public.menu_variants v on v.id = dc.variant_id
       group by dc.deal_id
    )
    select
      h.deal_id, max(h.name) as name, sum(h.qty)::int as qty_sold, sum(h.line_total_cents)::int as revenue_cents,
      coalesce(sum(c.cogs_cents),0)::int as cogs_cents,
      coalesce(bool_and(c.cogs_known), false) as cogs_known,
      (sum(h.line_total_cents) - coalesce(sum(c.cogs_cents),0))::int as contribution_cents,
      case when sum(h.line_total_cents) > 0
        then round((sum(h.line_total_cents) - coalesce(sum(c.cogs_cents),0))::numeric / sum(h.line_total_cents) * 1000) / 10
        else null end as contribution_margin_pct,
      case when sum(h.line_total_cents) > 0
        then round(coalesce(sum(c.cogs_cents),0)::numeric / sum(h.line_total_cents) * 1000) / 10
        else null end as food_cost_pct,
      max(lp.list_value_cents) as list_value_cents,
      case when max(lp.list_value_cents) is not null
        then (max(lp.list_value_cents) * sum(h.qty) - sum(h.line_total_cents))::int
        else null end as customer_saving_cents
      from header h
      left join comp c on c.order_id = h.order_id and c.deal_id = h.deal_id
      left join list_price lp on lp.deal_id = h.deal_id
     group by h.deal_id
     order by revenue_cents desc;
end $fn$;
revoke all on function public.deal_profitability(timestamptz, timestamptz) from public;
grant execute on function public.deal_profitability(timestamptz, timestamptz) to authenticated, service_role;

-- Menu engineering (spec §31): classify each à la carte item against the
-- period's own average popularity and average contribution-per-unit —
-- never by food-cost % alone, so a pricier-to-make item that still sells a
-- lot and earns real Rupees per unit doesn't get flagged as "bad".
create or replace function public.menu_engineering(p_from timestamptz, p_to timestamptz)
returns table (
  menu_item_id uuid, variant_id uuid, name text, qty_sold int, revenue_cents int,
  contribution_per_unit_cents int, total_contribution_cents int, quadrant text
)
language plpgsql stable security definer set search_path = public, app as $fn$
declare v_avg_qty numeric; v_avg_contrib numeric;
begin
  if not (app.has_perm('finance.view_profit') or app.has_perm('finance.view_cogs') or app.has_perm('inventory.view_cost')) then
    raise exception 'forbidden' using errcode = 'insufficient_privilege';
  end if;

  select avg(ip.qty_sold), avg(case when ip.qty_sold > 0 then ip.contribution_cents::numeric / ip.qty_sold else 0 end)
    into v_avg_qty, v_avg_contrib
    from public.item_profitability(p_from, p_to) ip;

  return query
    select
      ip.menu_item_id, ip.variant_id, ip.name, ip.qty_sold, ip.revenue_cents,
      case when ip.qty_sold > 0 then round(ip.contribution_cents::numeric / ip.qty_sold)::int else 0 end,
      ip.contribution_cents,
      case
        when ip.qty_sold >= coalesce(v_avg_qty,0) and (case when ip.qty_sold > 0 then ip.contribution_cents::numeric / ip.qty_sold else 0 end) >= coalesce(v_avg_contrib,0)
          then 'Star (high sales, high contribution)'
        when ip.qty_sold >= coalesce(v_avg_qty,0)
          then 'Plowhorse (high sales, low contribution)'
        when (case when ip.qty_sold > 0 then ip.contribution_cents::numeric / ip.qty_sold else 0 end) >= coalesce(v_avg_contrib,0)
          then 'Puzzle (low sales, high contribution)'
        else 'Dog (low sales, low contribution)'
      end
      from public.item_profitability(p_from, p_to) ip
     order by ip.revenue_cents desc;
end $fn$;
revoke all on function public.menu_engineering(timestamptz, timestamptz) from public;
grant execute on function public.menu_engineering(timestamptz, timestamptz) to authenticated, service_role;

-- ── Portals (Phase 2) ────────────────────────────────────────────────────
-- Super Admin (the owner) configures which portals exist. Each portal has its
-- own Supabase Auth user (portal_user_id) carrying app_metadata.portal_id +
-- app_metadata.permissions; routing is generated from route_key. Passwords are
-- never stored here — they live as Auth password hashes on portal_user_id.
create type app.portal_type as enum
  ('super_admin', 'checkout', 'kitchen', 'attendance', 'manager', 'custom');

create table public.portals (
  id           uuid primary key default gen_random_uuid(),
  name         text not null,
  type         app.portal_type not null default 'custom',
  route_key    text not null unique,
  status       text not null default 'active' check (status in ('active', 'disabled')),
  permissions  text[] not null default '{}',
  portal_user_id uuid,                       -- auth.users id of the portal login
  -- Mirror of that auth.users row's email (0047) — auth.users is still the
  -- source of truth and every write path updates it first; this column
  -- exists so Portal Management can list/edit the login email without an
  -- admin API round trip per row, the same way `permissions` above mirrors
  -- the login's app_metadata.
  email        text,
  force_pw_change boolean not null default false,
  last_login_at timestamptz,
  last_logout_at timestamptz,
  created_at   timestamptz not null default now(),
  created_by   uuid
);
create index portals_route_idx on public.portals(route_key);

create table public.portal_staff (
  portal_id     uuid not null references public.portals(id) on delete cascade,
  membership_id uuid not null references public.memberships(id) on delete cascade,
  primary key (portal_id, membership_id)
);

-- The portal id carried in the current JWT (empty for a person/owner login).
create or replace function app.current_portal_id()
returns uuid language sql stable as $$
  select nullif(
    nullif(current_setting('request.jwt.claims', true), '')::jsonb #>> '{app_metadata,portal_id}',
    ''
  )::uuid
$$;

-- A portal user clears its own force-password flag after changing the password.
create or replace function public.clear_force_pw_change()
returns void language plpgsql security definer set search_path = public, app as $fn$
declare v_pid uuid := app.current_portal_id();
begin
  if v_pid is null then
    raise exception 'not_a_portal_session' using errcode = 'insufficient_privilege';
  end if;
  update public.portals set force_pw_change = false where id = v_pid;
end $fn$;
revoke all on function public.clear_force_pw_change() from public;
grant execute on function public.clear_force_pw_change() to authenticated, service_role;

-- Portal session tracking (0053) — called by the web app right after a
-- successful sign-in and right before sign-out. No-op for a staff (non-
-- portal) login since current_portal_id() is only set on a 'kind: portal'
-- JWT, so the one shared login form / SignOutButton can call these
-- unconditionally. Also logs a 'portal.sign_in'/'portal.sign_out' row via
-- app.log_action() so the existing Audit log page surfaces this history.
create or replace function public.portal_record_sign_in()
returns void language plpgsql security definer set search_path = public, app as $fn$
declare v_pid uuid := app.current_portal_id();
begin
  if v_pid is null then return; end if;
  update public.portals set last_login_at = now() where id = v_pid;
  perform app.log_action('portal.sign_in', 'portals', v_pid::text);
end $fn$;
revoke all on function public.portal_record_sign_in() from public;
grant execute on function public.portal_record_sign_in() to authenticated, service_role;

create or replace function public.portal_record_sign_out()
returns void language plpgsql security definer set search_path = public, app as $fn$
declare v_pid uuid := app.current_portal_id();
begin
  if v_pid is null then return; end if;
  update public.portals set last_logout_at = now() where id = v_pid;
  perform app.log_action('portal.sign_out', 'portals', v_pid::text);
end $fn$;
revoke all on function public.portal_record_sign_out() from public;
grant execute on function public.portal_record_sign_out() to authenticated, service_role;

alter table public.portals enable row level security;
alter table public.portal_staff enable row level security;

-- Portal Management: anyone with portals.view reads all; a portal user always
-- reads its own row (its dashboard needs the config).
create policy portals_read on public.portals for select
  using (app.has_perm('portals.view') or id = app.current_portal_id());
create policy portals_write on public.portals for all
  using (app.has_perm('portals.update')) with check (app.has_perm('portals.update'));
-- The customer tracking page needs to know which counter(s) to send a guest
-- to once their order is ready — name only, nothing sensitive in that row
-- a guest couldn't already infer from being told where to pay.
create policy guest_read on public.portals for select
  using (type = 'checkout' and status = 'active');

create policy portal_staff_read on public.portal_staff for select
  using (app.has_perm('portals.view') or portal_id = app.current_portal_id());
create policy portal_staff_write on public.portal_staff for all
  using (app.has_perm('portals.update')) with check (app.has_perm('portals.update'));

-- Replace the full set of staff memberships linked to one portal (0044).
-- service_role-only — the API route re-checks the caller's own permissions
-- in JS first, same pattern as /api/staff/access; this is a second,
-- independent backstop for a direct RPC caller. Returns one row per
-- AFFECTED membership (old ∪ new — a member being unlinked needs its
-- permissions recomputed too), so the API can back-fill every affected
-- Auth user's app_metadata.permissions in one round trip.
create or replace function public.set_portal_staff(
  p_portal_id uuid, p_membership_ids uuid[]
) returns table(membership_id uuid, user_id uuid, effective text[])
language plpgsql security definer set search_path = public, app as $$
declare
  v_portal record;
  v_actor text[] := app.jwt_permissions();
  v_all boolean := ('*' = any(v_actor)) or app.jwt_role() = 'service_role';
  v_key text;
  v_new uuid[] := coalesce(p_membership_ids, '{}'::uuid[]);
begin
  if not app.has_perm('portals.update') then
    raise exception 'forbidden' using errcode = 'insufficient_privilege';
  end if;

  select id, type, status, permissions into v_portal from public.portals where id = p_portal_id;
  if not found then
    raise exception 'portal_not_found' using errcode = 'no_data_found';
  end if;
  if v_portal.type = 'super_admin' then
    raise exception 'the Super Admin portal cannot be assigned to staff' using errcode = 'insufficient_privilege';
  end if;

  if not v_all then
    foreach v_key in array v_portal.permissions loop
      if not (v_key = any(v_actor)) then
        raise exception 'cannot grant a permission you do not hold: %', v_key
          using errcode = 'insufficient_privilege';
      end if;
    end loop;
  end if;

  create temp table _affected(id uuid) on commit drop;
  insert into _affected select ps.membership_id from public.portal_staff ps where ps.portal_id = p_portal_id;
  insert into _affected select unnest(v_new) except select id from _affected;

  delete from public.portal_staff where portal_id = p_portal_id;
  insert into public.portal_staff (portal_id, membership_id)
    select p_portal_id, m_id from unnest(v_new) as m_id
    on conflict do nothing;

  perform app.log_action('portal.staff', 'portals', p_portal_id::text, null,
                         jsonb_build_object('membership_ids', v_new));

  return query
    select m.id, m.user_id,
           app.membership_effective_permissions(m.role::text, m.extra_permissions, m.id)
    from public.memberships m
    where m.id in (select id from _affected);
end $$;
revoke all on function public.set_portal_staff(uuid, uuid[]) from public, authenticated, anon;
grant execute on function public.set_portal_staff(uuid, uuid[]) to service_role;

-- Recompute one membership's effective permissions from its CURRENT stored
-- role/extra_permissions/portal_staff links (0044). Used after editing or
-- deleting a portal, to re-sync every staff member linked to it.
create or replace function public.membership_effective_permissions(
  p_membership_id uuid
) returns table(user_id uuid, effective text[])
language sql stable security definer set search_path = public, app as $$
  select m.user_id, app.membership_effective_permissions(m.role::text, m.extra_permissions, m.id)
  from public.memberships m
  where m.id = p_membership_id
$$;
revoke all on function public.membership_effective_permissions(uuid) from public, authenticated, anon;
grant execute on function public.membership_effective_permissions(uuid) to service_role;

do $$
declare tbl text;
begin
  foreach tbl in array array[
    'menu_categories','menu_items','menu_variants','modifier_groups','modifier_options','deals','deal_components',
    'inventory_items','recipe_components','modifier_recipe_components',
    'memberships','restaurant_tables','reservations',
    'promotions','suppliers','purchase_orders','shifts','attendance',
    'portals','portal_staff','roles','business_settings','attendance_settings',
    'payments','refunds','order_adjustments','food_stock_log','daily_closings'
  ] loop
    execute format(
      'create trigger audit after insert or update or delete on public.%I for each row execute function app.audit_row();',
      tbl
    );
  end loop;
end $$;

-- ── Export audit trail (Restaurant Performance & Owner Activity
-- Intelligence, spec §39) — one row per generated PDF/Excel report, so the
-- owner can see who exported what, when, and for which period. Written by
-- the API right after a report/export actually succeeds (or fails) —
-- never backfilled or inferred, and this table records exports only, not
-- the report CONTENT itself (which is never stored server-side; every
-- report is generated fresh from the same authoritative data each time).
create table public.export_audit_log (
  id                 uuid primary key default gen_random_uuid(),
  format             text not null check (format in ('pdf', 'excel')),
  -- 'complete' = the full multi-section report/workbook; any other value
  -- names the one section it was scoped to (e.g. 'suppliers',
  -- 'purchasing', 'inventory', 'orders', 'expenses') — a per-section
  -- export reuses the exact same generator, just narrowed.
  domain             text not null default 'complete',
  period_label       text not null,
  period_from        timestamptz not null,
  period_to          timestamptz not null,
  -- Only meaningful for a 'excel' export narrowed by the Custom Export
  -- sheet picker (spec §37) — null means the full workbook.
  sheets             text[],
  -- Path inside the private 'reports' bucket the generated file was
  -- saved to, so it can be re-downloaded later instead of regenerated —
  -- null when the file is not (or not yet) permanently stored (e.g. a
  -- 'failed' row, or before this column existed).
  storage_path       text,
  requested_by       uuid,
  requested_by_email text,
  requested_by_role  text,
  status             text not null default 'ready' check (status in ('ready', 'failed')),
  error              text,
  created_at         timestamptz not null default now()
);
create index export_audit_log_created_idx on public.export_audit_log(created_at desc);
alter table public.export_audit_log enable row level security;
create policy staff_read on public.export_audit_log for select
  using (app.has_perm('reports.view') or app.has_perm('reports.export') or app.has_perm('reports.generate') or app.is_staff());
create policy staff_insert on public.export_audit_log for insert
  with check (app.has_perm('reports.generate') or app.has_perm('reports.export') or app.can_write());
-- PDF generation happens client-side — the row is inserted server-side
-- before the PDF bytes exist, then patched with storage_path once the
-- browser renders and uploads the file. Excel is generated server-side in
-- one request, so its row never needs this update path.
create policy staff_update on public.export_audit_log for update
  using (app.has_perm('reports.generate') or app.has_perm('reports.export') or app.can_write())
  with check (app.has_perm('reports.generate') or app.has_perm('reports.export') or app.can_write());

-- Permanent report storage: every generated PDF/Excel file is saved here
-- (private bucket — a restaurant's financial reports are never public),
-- keyed by the export_audit_log row's storage_path. A report is still
-- always COMPUTED fresh from live data each time it's generated; storing
-- the resulting file just means it can be re-downloaded byte-for-byte
-- later without re-running the generation.
insert into storage.buckets (id, name, public) values ('reports', 'reports', false) on conflict (id) do nothing;
create policy "reports staff read" on storage.objects for select
  using (bucket_id = 'reports' and (app.has_perm('reports.view') or app.has_perm('reports.export') or app.has_perm('reports.generate') or app.is_staff()));
create policy "reports staff write" on storage.objects for all
  using (bucket_id = 'reports' and (app.has_perm('reports.export') or app.has_perm('reports.generate') or app.can_write()))
  with check (bucket_id = 'reports' and (app.has_perm('reports.export') or app.has_perm('reports.generate') or app.can_write()));

-- ── Social media (Instagram) — connected accounts + a draft/approval queue
-- for AI-proposed posts. Publishing is a SEPARATE, explicit human action
-- (POST /api/social/publish/:id, social.approve_post) from drafting
-- (social.propose_post) — the same two-gate shape as draft_deal (created
-- off, a manager must separately switch it on) and draft_recipe (created
-- draft, must be separately activated). Nothing here ever posts on its own.
create table public.social_accounts (
  id                 uuid primary key default gen_random_uuid(),
  platform           text not null check (platform in ('instagram')),
  account_name       text,
  account_id         text not null,
  -- The long-lived Page access token used for the Instagram Graph API
  -- (never the short-lived user token from the OAuth callback itself).
  access_token       text not null,
  token_expires_at   timestamptz,
  status             text not null default 'connected' check (status in ('connected', 'expired', 'disconnected')),
  connected_by       uuid,
  connected_at       timestamptz not null default now(),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (platform, account_id)
);
create table public.social_posts (
  id                 uuid primary key default gen_random_uuid(),
  platform           text not null check (platform in ('instagram')),
  account_id         uuid references public.social_accounts(id) on delete set null,
  caption            text not null,
  -- A publicly reachable image URL (Instagram's Graph API requires one to
  -- build the media container) — auto-filled from the referenced deal/menu
  -- item's own image_url when draft_social_post is given one that has a
  -- photo on file; left null otherwise for a manager to add before publishing.
  media_url          text,
  related_type       text check (related_type is null or related_type in ('deal', 'promotion', 'menu_item')),
  related_id         uuid,
  status             text not null default 'draft' check (status in ('draft', 'approved', 'rejected', 'published', 'failed')),
  proposed_by        uuid,
  proposed_by_role   text,
  approved_by        uuid,
  approved_at        timestamptz,
  published_at       timestamptz,
  external_post_id   text,
  error              text,
  created_at         timestamptz not null default now()
);
create index social_posts_status_idx on public.social_posts(status, created_at desc);
alter table public.social_accounts enable row level security;
alter table public.social_posts enable row level security;
create policy staff_read on public.social_accounts for select
  using (app.has_perm('social.view') or app.can_write());
create policy staff_write on public.social_accounts for all
  using (app.has_perm('social.manage') or app.can_write())
  with check (app.has_perm('social.manage') or app.can_write());
create policy staff_read on public.social_posts for select
  using (app.has_perm('social.view') or app.can_write());
create policy staff_insert on public.social_posts for insert
  with check (app.has_perm('social.propose_post') or app.can_write());
-- Covers both a manager editing a draft (caption/media_url) and actually
-- publishing it (status -> 'published') — the API re-checks
-- social.approve_post specifically before ever calling the Graph API,
-- this policy is the data-layer backstop, not the only gate.
create policy staff_update on public.social_posts for update
  using (app.has_perm('social.propose_post') or app.has_perm('social.approve_post') or app.can_write())
  with check (app.has_perm('social.propose_post') or app.has_perm('social.approve_post') or app.can_write());
create trigger audit_social_accounts after insert or update or delete on public.social_accounts
  for each row execute function app.audit_row();
create trigger audit_social_posts after insert or update or delete on public.social_posts
  for each row execute function app.audit_row();

-- ── Recipe-driven product availability engine (0052) ────────────────────
-- Layers a derived "can we actually make this right now" signal on top of
-- the existing manual toggles — see tenant-migrations/0052 for full
-- rationale (kept in one place there rather than duplicated in both files).

create table public.product_availability (
  id                           uuid primary key default gen_random_uuid(),
  menu_item_id                 uuid not null references public.menu_items(id) on delete cascade,
  variant_id                   uuid references public.menu_variants(id) on delete cascade,
  status                       text not null check (status in ('available', 'low_stock', 'unavailable')),
  producible_qty                numeric(14,3),
  bottleneck_inventory_item_id uuid references public.inventory_items(id) on delete set null,
  reason                       text,
  updated_at                   timestamptz not null default now()
);
create unique index product_availability_key_idx on public.product_availability(menu_item_id, variant_id) nulls not distinct;
create index product_availability_item_idx on public.product_availability(menu_item_id);
alter table public.product_availability enable row level security;
create policy guest_read on public.product_availability for select using (true);
create policy staff_read on public.product_availability for select using (app.has_perm('availability.view') or app.is_staff());

create table public.availability_audit_log (
  id                           bigint generated always as identity primary key,
  menu_item_id                 uuid not null references public.menu_items(id) on delete cascade,
  variant_id                   uuid references public.menu_variants(id) on delete cascade,
  previous_status               text,
  new_status                    text not null,
  previous_producible_qty        numeric(14,3),
  new_producible_qty             numeric(14,3),
  bottleneck_inventory_item_id uuid references public.inventory_items(id) on delete set null,
  reason                       text,
  trigger_type                 text not null,
  trigger_reference            text,
  actor                        text not null default 'system',
  created_at                   timestamptz not null default now()
);
create index availability_audit_log_item_idx on public.availability_audit_log(menu_item_id, created_at desc);
create index availability_audit_log_created_idx on public.availability_audit_log(created_at desc);
alter table public.availability_audit_log enable row level security;
create policy staff_read on public.availability_audit_log for select using (app.has_perm('availability.view') or app.is_staff());

-- ── Shared calculation core (0054) — the same math every version of this
-- engine has used (floor(stock/qty_per_unit), bottleneck tracking,
-- required-modifier-group viability), parameterized only on which stock
-- figure to read per ingredient: live inventory_items.stock_qty
-- (p_use_priority_pool = false — the plain per-product engine below) or
-- priority_stock_pool.remaining (p_use_priority_pool = true — the
-- priority waterfall, tenant-migrations/0054). Both callers share this
-- ONE implementation rather than duplicating it.
create or replace function app.compute_product_capacity(
  p_menu_item_id uuid, p_variant_id uuid, p_use_priority_pool boolean default false
) returns table (
  tracked boolean, status text, producible_qty numeric,
  bottleneck_inventory_item_id uuid, reason text
) language plpgsql stable security definer set search_path = public, app as $fn$
declare
  v_effective_variant uuid;
  v_has_variant_recipe boolean;
  v_comp record;
  v_capacity numeric;
  v_min_capacity numeric;
  v_bottleneck uuid;
  v_bottleneck_name text;
  v_bottleneck_low boolean;
  v_has_recipe boolean := false;
  v_tracked boolean := false;
  v_producible numeric;
  v_status text;
  v_reason text;
  v_req_group record;
  v_group_viable boolean;
  v_opt record;
  v_opt_cap numeric;
  v_opt_row record;
  v_cap numeric;
  v_needs_modifier_override boolean := false;
  v_modifier_reason text;
begin
  if p_variant_id is not null then
    select exists(
      select 1 from public.recipe_components where menu_item_id = p_menu_item_id and variant_id = p_variant_id
    ) into v_has_variant_recipe;
    v_effective_variant := case when v_has_variant_recipe then p_variant_id else null end;
  else
    v_effective_variant := null;
  end if;

  v_min_capacity := null;
  for v_comp in
    select rc.inventory_item_id, rc.qty_per_unit, i.min_threshold, i.name,
           case when p_use_priority_pool then coalesce(ps.remaining, i.stock_qty) else i.stock_qty end as eff_stock
      from public.recipe_components rc
      join public.inventory_items i on i.id = rc.inventory_item_id
      left join public.priority_stock_pool ps on p_use_priority_pool and ps.inventory_item_id = rc.inventory_item_id
     where rc.menu_item_id = p_menu_item_id
       and rc.variant_id is not distinct from v_effective_variant
  loop
    v_has_recipe := true;
    v_capacity := floor(greatest(v_comp.eff_stock, 0) / v_comp.qty_per_unit);
    if v_min_capacity is null or v_capacity < v_min_capacity then
      v_min_capacity := v_capacity;
      v_bottleneck := v_comp.inventory_item_id;
      v_bottleneck_name := v_comp.name;
      v_bottleneck_low := v_comp.eff_stock <= v_comp.min_threshold;
    end if;
  end loop;

  if v_has_recipe then
    v_tracked := true;
    v_producible := v_min_capacity;
    if v_producible <= 0 then
      v_status := 'unavailable';
      v_reason := v_bottleneck_name || ' unavailable';
    elsif v_bottleneck_low then
      v_status := 'low_stock';
      v_reason := v_bottleneck_name || ' approaching reorder level';
    else
      v_status := 'available';
      v_reason := null;
    end if;
  else
    -- No base/variant recipe — nothing constrains capacity from that side,
    -- but the required-modifier-group check below may still find a real
    -- constraint (e.g. a "Choose Sauce" group whose only ingredient link is
    -- on its options, not the item itself — spec §9 / §31 scenario 7).
    v_producible := null;
    v_status := 'available';
    v_reason := null;
  end if;

  -- Checked unconditionally, even when the item has no base recipe of its
  -- own — a required group with nothing left to pick makes the product
  -- itself unorderable regardless of whether it has other ingredients.
  for v_req_group in
    select id, name from public.modifier_groups
     where menu_item_id = p_menu_item_id and min_select >= 1
  loop
    v_tracked := true;
    v_group_viable := false;
    for v_opt in
      select id from public.modifier_options where group_id = v_req_group.id and is_available
    loop
      v_opt_cap := null;
      for v_opt_row in
        select mrc.qty_base,
               case when p_use_priority_pool then coalesce(ps.remaining, i.stock_qty) else i.stock_qty end as eff_stock
          from public.modifier_recipe_components mrc
          join public.inventory_items i on i.id = mrc.inventory_item_id
          left join public.priority_stock_pool ps on p_use_priority_pool and ps.inventory_item_id = mrc.inventory_item_id
         where mrc.modifier_option_id = v_opt.id
      loop
        v_cap := floor(greatest(v_opt_row.eff_stock, 0) / v_opt_row.qty_base);
        if v_opt_cap is null or v_cap < v_opt_cap then v_opt_cap := v_cap; end if;
      end loop;
      if v_opt_cap is null or v_opt_cap > 0 then
        v_group_viable := true;
        exit;
      end if;
    end loop;
    if not v_group_viable then
      v_needs_modifier_override := true;
      v_modifier_reason := 'No available options for ' || v_req_group.name;
      exit;
    end if;
  end loop;

  if v_needs_modifier_override and v_status is distinct from 'unavailable' then
    v_status := 'unavailable';
    v_reason := v_modifier_reason;
    v_producible := 0;
  end if;

  return query select v_tracked, v_status, v_producible, v_bottleneck, v_reason;
end;
$fn$;

-- ── Shared write core (0054) — upserts product_availability and, only on
-- a real change, appends to availability_audit_log + app.log_action.
-- Used by both the plain engine and the priority waterfall so every
-- consumer keeps reading the ONE same table regardless of which path
-- computed it.
create or replace function app.apply_product_availability_result(
  p_menu_item_id uuid, p_variant_id uuid, p_tracked boolean, p_status text, p_producible numeric,
  p_bottleneck uuid, p_reason text, p_trigger_type text, p_trigger_reference text, p_actor text
) returns void language plpgsql security definer set search_path = public, app as $fn$
declare v_prev record;
begin
  if not p_tracked then
    delete from public.product_availability
     where menu_item_id = p_menu_item_id and variant_id is not distinct from p_variant_id;
    return;
  end if;

  select status, producible_qty into v_prev
    from public.product_availability
   where menu_item_id = p_menu_item_id and variant_id is not distinct from p_variant_id;

  insert into public.product_availability
    (menu_item_id, variant_id, status, producible_qty, bottleneck_inventory_item_id, reason, updated_at)
  values
    (p_menu_item_id, p_variant_id, p_status, p_producible, p_bottleneck, p_reason, now())
  on conflict (menu_item_id, variant_id) do update set
    status = excluded.status,
    producible_qty = excluded.producible_qty,
    bottleneck_inventory_item_id = excluded.bottleneck_inventory_item_id,
    reason = excluded.reason,
    updated_at = now();

  if v_prev is null or v_prev.status is distinct from p_status or v_prev.producible_qty is distinct from p_producible then
    insert into public.availability_audit_log
      (menu_item_id, variant_id, previous_status, new_status, previous_producible_qty, new_producible_qty,
       bottleneck_inventory_item_id, reason, trigger_type, trigger_reference, actor)
    values
      (p_menu_item_id, p_variant_id, v_prev.status, p_status, v_prev.producible_qty, p_producible,
       p_bottleneck, p_reason, p_trigger_type, p_trigger_reference, p_actor);
    perform app.log_action('availability.changed', 'menu_items', p_menu_item_id::text, null,
      jsonb_build_object('variant_id', p_variant_id, 'status', p_status, 'producible_qty', p_producible, 'reason', p_reason));
  end if;
end;
$fn$;

create or replace function app.recalc_product_availability(
  p_menu_item_id uuid,
  p_variant_id uuid,
  p_trigger_type text default 'manual_recalculation',
  p_trigger_reference text default null,
  p_actor text default 'system'
) returns void
language plpgsql security definer set search_path = public, app as $$
declare v_r record;
begin
  select * into v_r from app.compute_product_capacity(p_menu_item_id, p_variant_id, false);
  perform app.apply_product_availability_result(
    p_menu_item_id, p_variant_id, v_r.tracked, v_r.status, v_r.producible_qty,
    v_r.bottleneck_inventory_item_id, v_r.reason, p_trigger_type, p_trigger_reference, p_actor
  );
end;
$$;

create or replace function app.recalc_products_for_ingredient(
  p_inventory_item_id uuid, p_trigger_type text, p_trigger_reference text default null
) returns void
language plpgsql security definer set search_path = public, app as $$
declare r record;
begin
  for r in
    select distinct menu_item_id, variant_id from public.recipe_components
     where inventory_item_id = p_inventory_item_id
  loop
    perform app.recalc_product_availability(r.menu_item_id, r.variant_id, p_trigger_type, p_trigger_reference);
  end loop;

  for r in
    select distinct x.menu_item_id, x.variant_id
      from public.modifier_recipe_components mrc
      join public.modifier_options mo on mo.id = mrc.modifier_option_id
      join public.modifier_groups mg on mg.id = mo.group_id
      join public.product_availability x on x.menu_item_id = mg.menu_item_id
     where mrc.inventory_item_id = p_inventory_item_id
  loop
    perform app.recalc_product_availability(r.menu_item_id, r.variant_id, p_trigger_type, p_trigger_reference);
  end loop;

  for r in
    select distinct mg.menu_item_id
      from public.modifier_recipe_components mrc
      join public.modifier_options mo on mo.id = mrc.modifier_option_id
      join public.modifier_groups mg on mg.id = mo.group_id
     where mrc.inventory_item_id = p_inventory_item_id
       and not exists (select 1 from public.product_availability x where x.menu_item_id = mg.menu_item_id)
  loop
    perform app.recalc_product_availability(r.menu_item_id, null, p_trigger_type, p_trigger_reference);
  end loop;
end;
$$;

create or replace function app.on_inventory_stock_change() returns trigger
language plpgsql security definer set search_path = public, app as $$
begin
  if new.stock_qty is distinct from old.stock_qty then
    if exists(select 1 from public.product_priority) then
      perform app.recalc_priority_allocation(
        case when new.stock_qty > old.stock_qty then 'inventory_restock' else 'inventory_consumption' end,
        null
      );
    else
      perform app.recalc_products_for_ingredient(
        new.id,
        case when new.stock_qty > old.stock_qty then 'inventory_restock' else 'inventory_consumption' end,
        null
      );
    end if;
  end if;
  return new;
end;
$$;
drop trigger if exists recalc_availability_on_stock_change on public.inventory_items;
create trigger recalc_availability_on_stock_change after update of stock_qty on public.inventory_items
  for each row execute function app.on_inventory_stock_change();

create or replace function app.on_recipe_components_change() returns trigger
language plpgsql security definer set search_path = public, app as $$
declare v_item uuid; v_variant uuid;
begin
  if tg_op = 'DELETE' then
    v_item := old.menu_item_id; v_variant := old.variant_id;
  else
    v_item := new.menu_item_id; v_variant := new.variant_id;
  end if;
  if exists(select 1 from public.product_priority) then
    perform app.recalc_priority_allocation('recipe_change', null);
  else
    perform app.recalc_product_availability(v_item, v_variant, 'recipe_change', null);
    if v_variant is not null then
      perform app.recalc_product_availability(v_item, null, 'recipe_change', null);
    end if;
  end if;
  return coalesce(new, old);
end;
$$;
drop trigger if exists recalc_availability_on_recipe_change on public.recipe_components;
create trigger recalc_availability_on_recipe_change after insert or update or delete on public.recipe_components
  for each row execute function app.on_recipe_components_change();

create or replace function app.on_modifier_recipe_components_change() returns trigger
language plpgsql security definer set search_path = public, app as $$
declare v_option uuid; v_item uuid; r record;
begin
  v_option := coalesce(new.modifier_option_id, old.modifier_option_id);
  select mg.menu_item_id into v_item
    from public.modifier_options mo join public.modifier_groups mg on mg.id = mo.group_id
   where mo.id = v_option;
  if v_item is not null then
    if exists(select 1 from public.product_priority) then
      perform app.recalc_priority_allocation('recipe_change', null);
    else
      for r in select variant_id from public.product_availability where menu_item_id = v_item loop
        perform app.recalc_product_availability(v_item, r.variant_id, 'recipe_change', null);
      end loop;
      perform app.recalc_product_availability(v_item, null, 'recipe_change', null);
    end if;
  end if;
  return coalesce(new, old);
end;
$$;
drop trigger if exists recalc_availability_on_modifier_recipe_change on public.modifier_recipe_components;
create trigger recalc_availability_on_modifier_recipe_change after insert or update or delete on public.modifier_recipe_components
  for each row execute function app.on_modifier_recipe_components_change();

create or replace function app.on_modifier_option_availability_change() returns trigger
language plpgsql security definer set search_path = public, app as $$
declare v_item uuid; r record;
begin
  if new.is_available is distinct from old.is_available then
    select mg.menu_item_id into v_item from public.modifier_groups mg where mg.id = new.group_id;
    if v_item is not null then
      if exists(select 1 from public.product_priority) then
        perform app.recalc_priority_allocation('recipe_change', null);
      else
        for r in select variant_id from public.product_availability where menu_item_id = v_item loop
          perform app.recalc_product_availability(v_item, r.variant_id, 'recipe_change', null);
        end loop;
        perform app.recalc_product_availability(v_item, null, 'recipe_change', null);
      end if;
    end if;
  end if;
  return new;
end;
$$;
drop trigger if exists recalc_availability_on_modifier_option_change on public.modifier_options;
create trigger recalc_availability_on_modifier_option_change after update of is_available on public.modifier_options
  for each row execute function app.on_modifier_option_availability_change();

create or replace function public.get_product_availability_detail(p_menu_item_id uuid, p_variant_id uuid default null)
returns table (
  inventory_item_id uuid, ingredient_name text, unit text,
  stock_qty numeric, qty_per_unit numeric, capacity numeric
)
language plpgsql security definer set search_path = public, app as $$
declare v_effective_variant uuid; v_has_variant_recipe boolean;
begin
  if not (app.has_perm('availability.view') or app.has_perm('inventory.view_cost') or app.is_staff()) then
    raise exception 'forbidden' using errcode = 'insufficient_privilege';
  end if;
  if p_variant_id is not null then
    select exists(select 1 from public.recipe_components where menu_item_id = p_menu_item_id and variant_id = p_variant_id)
      into v_has_variant_recipe;
    v_effective_variant := case when v_has_variant_recipe then p_variant_id else null end;
  else
    v_effective_variant := null;
  end if;
  return query
    select rc.inventory_item_id, i.name, i.unit, i.stock_qty, rc.qty_per_unit,
           floor(greatest(i.stock_qty, 0) / rc.qty_per_unit) as capacity
      from public.recipe_components rc
      join public.inventory_items i on i.id = rc.inventory_item_id
     where rc.menu_item_id = p_menu_item_id and rc.variant_id is not distinct from v_effective_variant
     order by capacity asc;
end;
$$;
revoke all on function public.get_product_availability_detail(uuid, uuid) from public;
grant execute on function public.get_product_availability_detail(uuid, uuid) to authenticated, service_role;

create or replace function public.recalculate_all_product_availability()
returns void
language plpgsql security definer set search_path = public, app as $$
declare r record;
begin
  if not (app.has_perm('availability.update') or app.is_staff()) then
    raise exception 'forbidden' using errcode = 'insufficient_privilege';
  end if;
  for r in select distinct menu_item_id, variant_id from public.recipe_components loop
    perform app.recalc_product_availability(r.menu_item_id, r.variant_id, 'manual_recalculation', null);
  end loop;
  -- Items with no base/variant recipe at all, but a required modifier
  -- group of their own — recalc_product_availability() tracks these too
  -- (spec §31 scenario 7), so the bulk backfill needs to reach them even
  -- though recipe_components has no row for them.
  for r in
    select distinct mg.menu_item_id
      from public.modifier_groups mg
     where mg.min_select >= 1
       and not exists (select 1 from public.recipe_components rc where rc.menu_item_id = mg.menu_item_id)
  loop
    perform app.recalc_product_availability(r.menu_item_id, null, 'manual_recalculation', null);
  end loop;
  perform app.recalc_priority_allocation('manual_recalculation', null);
end;
$$;
revoke all on function public.recalculate_all_product_availability() from public;
grant execute on function public.recalculate_all_product_availability() to authenticated, service_role;

alter publication supabase_realtime add table public.product_availability;

-- ── Recipe/Menu Inventory Consumption Priority (0054) ────────────────────
-- Which menu items are "key" enough to have an explicit priority, and
-- their level (critical/high/medium/low) + rank (drag-and-drop position
-- within that level). Absence here means "no explicit priority" — such a
-- product still joins the waterfall (as lowest priority, alphabetical)
-- whenever ANY priority exists tenant-wide, so it sees the true leftover
-- stock after prioritized products claim theirs.
create table public.product_priority (
  id             uuid primary key default gen_random_uuid(),
  menu_item_id   uuid not null unique references public.menu_items(id) on delete cascade,
  priority_level text not null default 'medium' check (priority_level in ('critical', 'high', 'medium', 'low')),
  priority_rank  int not null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create unique index product_priority_level_rank_uq on public.product_priority(priority_level, priority_rank);
alter table public.product_priority enable row level security;
create policy staff_read on public.product_priority for select using (app.has_perm('availability.view') or app.is_staff());
-- No direct write policy — writes only through set_product_priority/
-- remove_product_priority/reorder_product_priority below (SECURITY
-- DEFINER), same immutable-from-client convention product_availability/
-- availability_audit_log already use.
create trigger audit_product_priority after insert or update or delete on public.product_priority
  for each row execute function app.audit_row();

-- Scratch working state for ONE app.recalc_priority_allocation() run —
-- reseeded from live inventory_items.stock_qty at the start of every call,
-- decremented as each product in priority order claims its share. Never
-- read outside that function.
create table public.priority_stock_pool (
  inventory_item_id uuid primary key references public.inventory_items(id) on delete cascade,
  remaining         numeric(14,3) not null default 0
);
alter table public.priority_stock_pool enable row level security;
create policy staff_read on public.priority_stock_pool for select using (app.has_perm('availability.view') or app.is_staff());

alter publication supabase_realtime add table public.product_priority;

-- No-op when no priority is configured. Otherwise: reseed the working
-- stock pool from live inventory, then walk every tracked (menu_item,
-- variant) pair in priority order — critical, then high, then medium,
-- then low, each ordered by rank within that level; anything with no
-- explicit priority comes last, alphabetically. Each product's capacity
-- is computed against whatever remains in the pool, then its own claim
-- (producible_qty × qty_per_unit, per ingredient) is deducted before the
-- next, lower-priority product is computed — a single-pass greedy
-- allocation: the direct, auditable meaning of "higher priority gets
-- shared capacity first".
create or replace function app.recalc_priority_allocation(
  p_trigger_type text default 'priority_reallocation', p_trigger_reference text default null
) returns void language plpgsql security definer set search_path = public, app as $fn$
declare
  v_has_priorities boolean;
  v_prod record;
  v_r record;
  v_effective_variant uuid;
  v_has_variant_recipe boolean;
begin
  select exists(select 1 from public.product_priority) into v_has_priorities;
  if not v_has_priorities then
    return;
  end if;

  delete from public.priority_stock_pool where true;
  insert into public.priority_stock_pool (inventory_item_id, remaining)
    select id, greatest(stock_qty, 0) from public.inventory_items;

  for v_prod in
    select x.menu_item_id, x.variant_id,
           case coalesce(pp.priority_level, 'unprioritized')
             when 'critical' then 0 when 'high' then 1 when 'medium' then 2 when 'low' then 3
             else 4
           end as level_rank,
           coalesce(pp.priority_rank, 999999) as rank_in_level,
           mi.name as item_name
      from (
        select distinct menu_item_id, variant_id from public.recipe_components
        union
        select distinct mg.menu_item_id, null::uuid from public.modifier_groups mg where mg.min_select >= 1
      ) x
      join public.menu_items mi on mi.id = x.menu_item_id
      left join public.product_priority pp on pp.menu_item_id = x.menu_item_id
     order by level_rank, rank_in_level, mi.name, x.variant_id nulls first
  loop
    select * into v_r from app.compute_product_capacity(v_prod.menu_item_id, v_prod.variant_id, true);
    perform app.apply_product_availability_result(
      v_prod.menu_item_id, v_prod.variant_id, v_r.tracked, v_r.status, v_r.producible_qty,
      v_r.bottleneck_inventory_item_id, v_r.reason, p_trigger_type, p_trigger_reference, 'system'
    );

    if v_r.tracked and coalesce(v_r.producible_qty, 0) > 0 then
      if v_prod.variant_id is not null then
        select exists(select 1 from public.recipe_components where menu_item_id = v_prod.menu_item_id and variant_id = v_prod.variant_id)
          into v_has_variant_recipe;
        v_effective_variant := case when v_has_variant_recipe then v_prod.variant_id else null end;
      else
        v_effective_variant := null;
      end if;

      update public.priority_stock_pool ps
         set remaining = ps.remaining - (v_r.producible_qty * rc.qty_per_unit)
        from public.recipe_components rc
       where rc.menu_item_id = v_prod.menu_item_id
         and rc.variant_id is not distinct from v_effective_variant
         and ps.inventory_item_id = rc.inventory_item_id;
    end if;
  end loop;
end;
$fn$;

create or replace function public.set_product_priority(p_menu_item_id uuid, p_priority_level text)
returns void language plpgsql security definer set search_path = public, app as $fn$
declare v_next_rank int; v_cur_level text;
begin
  if not (app.has_perm('availability.update') or app.can_write()) then
    raise exception 'forbidden' using errcode = 'insufficient_privilege';
  end if;
  if p_priority_level not in ('critical', 'high', 'medium', 'low') then
    raise exception 'bad_priority_level' using errcode = 'check_violation';
  end if;

  select priority_level into v_cur_level from public.product_priority where menu_item_id = p_menu_item_id;

  if v_cur_level is null then
    select coalesce(max(priority_rank), 0) + 1 into v_next_rank from public.product_priority where priority_level = p_priority_level;
    insert into public.product_priority (menu_item_id, priority_level, priority_rank)
    values (p_menu_item_id, p_priority_level, v_next_rank);
  elsif v_cur_level <> p_priority_level then
    select coalesce(max(priority_rank), 0) + 1 into v_next_rank from public.product_priority where priority_level = p_priority_level;
    update public.product_priority set priority_level = p_priority_level, priority_rank = v_next_rank, updated_at = now()
     where menu_item_id = p_menu_item_id;
  end if;

  perform app.recalc_priority_allocation('priority_change', p_menu_item_id::text);
end;
$fn$;
revoke all on function public.set_product_priority(uuid, text) from public;
grant execute on function public.set_product_priority(uuid, text) to authenticated, service_role;

create or replace function public.remove_product_priority(p_menu_item_id uuid)
returns void language plpgsql security definer set search_path = public, app as $fn$
begin
  if not (app.has_perm('availability.update') or app.can_write()) then
    raise exception 'forbidden' using errcode = 'insufficient_privilege';
  end if;
  delete from public.product_priority where menu_item_id = p_menu_item_id;
  if not exists (select 1 from public.product_priority) then
    perform public.recalculate_all_product_availability();
  else
    perform app.recalc_priority_allocation('priority_change', p_menu_item_id::text);
  end if;
end;
$fn$;
revoke all on function public.remove_product_priority(uuid) from public;
grant execute on function public.remove_product_priority(uuid) to authenticated, service_role;

create or replace function public.reorder_product_priority(p_priority_level text, p_ordered_menu_item_ids uuid[])
returns void language plpgsql security definer set search_path = public, app as $fn$
declare v_id uuid; v_rank int := 1;
begin
  if not (app.has_perm('availability.update') or app.can_write()) then
    raise exception 'forbidden' using errcode = 'insufficient_privilege';
  end if;
  if p_priority_level not in ('critical', 'high', 'medium', 'low') then
    raise exception 'bad_priority_level' using errcode = 'check_violation';
  end if;

  update public.product_priority set priority_rank = priority_rank + 1000000
   where priority_level = p_priority_level and menu_item_id = any(p_ordered_menu_item_ids);

  foreach v_id in array p_ordered_menu_item_ids loop
    update public.product_priority set priority_rank = v_rank, updated_at = now()
     where menu_item_id = v_id and priority_level = p_priority_level;
    v_rank := v_rank + 1;
  end loop;

  perform app.recalc_priority_allocation('priority_change', null);
end;
$fn$;
revoke all on function public.reorder_product_priority(text, uuid[]) from public;
grant execute on function public.reorder_product_priority(text, uuid[]) to authenticated, service_role;

-- ── Seed ─────────────────────────────────────────────────────────────────
insert into public.menu_categories (name) values ('Uncategorised');

-- The implicit Super Admin portal (the owner). No portal_user_id — the owner
-- signs in as a person; this row just anchors "everything" in Portal Management.
insert into public.portals (name, type, route_key, permissions)
values ('Super Admin', 'super_admin', 'admin', array['*']);

-- ════════════════════════════════════════════════════════════════════════════
-- 0058 — portal permission coverage (verbatim from tenant-migrations/0058)
-- ════════════════════════════════════════════════════════════════════════════
-- ============================================================================
-- Tenant delta 0058 — every Create Portal permission option does something.
--
-- 61 of the 127 permission_catalog keys had no effect on a generated custom
-- portal: some were enforced server-side but never wired into a screen, some
-- were checkboxes with no enforcement or feature behind them at all. This
-- migration adds the server-side half for the second kind:
--
--   * Per-operation RLS for keys that name one operation on a table whose
--     existing policy only checks a broader key — tables.create, deals.create/
--     archive, variants.*, purchases.create/delete, supplier.create/update,
--     roles.create/delete. These are ADDITIVE permissive policies: every
--     existing policy is left in place, so no current user loses anything.
--   * RPCs for actions that had no implementation — adjust_payment,
--     payment reconciliation, cash counts, ingredient costs, attendance
--     corrections/dashboard/history, review responses/moderation/analytics,
--     member access list.
--   * New tables for features that didn't exist — customers, cash_counts,
--     attendance_corrections — plus review response/moderation columns on
--     feedback.
--   * Anti-escalation triggers on portals and roles. The portals_write and
--     roles mgr_write RLS policies let any holder of portals.update /
--     roles.update write rows DIRECTLY through PostgREST, skipping the API's
--     "can't grant what you don't hold" check. Harmless while only the owner
--     held those keys; now that Portal Management can be delegated to a
--     custom portal, the database itself enforces it.
--
-- Idempotent: every policy is dropped-if-exists first, every table/column is
-- if-not-exists, every function is create-or-replace.
-- ============================================================================

-- Defined in 0044; repeated here (identical body) because at least one tenant
-- reached v57 without it.
create or replace function app.jwt_role()
returns text language sql stable as $$
  select nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role'
$$;

-- ── Anti-escalation helper ────────────────────────────────────────────────
-- True when every key in p_perms is held by the caller. service_role, '*'
-- holders and legacy owner/manager JWTs (no permissions array, can_write())
-- pass — the same callers app.has_perm() already treats as unrestricted.
create or replace function app.caller_holds_all(p_perms text[])
returns boolean language sql stable as $$
  select
    app.jwt_role() = 'service_role'
    or '*' = any(app.jwt_permissions())
    or (app.jwt_permissions() = '{}'::text[] and app.can_write())
    or (not ('*' = any(coalesce(p_perms, '{}'::text[])))
        and coalesce(p_perms, '{}'::text[]) <@ app.jwt_permissions())
$$;

-- ── Portals: database-level anti-escalation ───────────────────────────────
create or replace function app.guard_portal_write() returns trigger
language plpgsql as $$
begin
  -- Direct database sessions (provisioning, migrations) carry no JWT.
  if app.jwt_role() = 'service_role' or nullif(current_setting('request.jwt.claims', true), '') is null then
    return coalesce(new, old);
  end if;
  -- Bookkeeping a portal does on its own row (last sign-in/out, clearing
  -- force_pw_change) doesn't touch access, so it isn't guarded.
  if tg_op = 'UPDATE'
     and (new.name, new.type, new.route_key, new.status, new.permissions, new.portal_user_id, new.email)
         is not distinct from
         (old.name, old.type, old.route_key, old.status, old.permissions, old.portal_user_id, old.email) then
    return new;
  end if;
  if tg_op in ('UPDATE', 'DELETE') then
    if old.type = 'super_admin' then
      raise exception 'the Super Admin portal cannot be changed' using errcode = 'insufficient_privilege';
    end if;
    -- A portal can never manage itself, and nobody can touch a portal that
    -- holds access they don't.
    if old.id = app.current_portal_id() then
      raise exception 'a portal cannot change its own access' using errcode = 'insufficient_privilege';
    end if;
    if not app.caller_holds_all(old.permissions) then
      raise exception 'that portal holds access you do not have' using errcode = 'insufficient_privilege';
    end if;
  end if;
  if tg_op in ('INSERT', 'UPDATE') then
    if new.type = 'super_admin' and tg_op = 'INSERT' then
      raise exception 'only one Super Admin portal exists' using errcode = 'insufficient_privilege';
    end if;
    if not app.caller_holds_all(new.permissions) then
      raise exception 'cannot grant a permission you do not hold' using errcode = 'insufficient_privilege';
    end if;
    -- Enable/disable alone needs portals.disable, everything else portals.update.
    if tg_op = 'UPDATE' and new.status is distinct from old.status
       and not (app.has_perm('portals.disable') or app.has_perm('portals.update')) then
      raise exception 'forbidden' using errcode = 'insufficient_privilege';
    end if;
    -- portals.disable alone may flip status and nothing else.
    if tg_op = 'UPDATE' and not app.has_perm('portals.update')
       and (new.name, new.type, new.route_key, new.permissions, new.portal_user_id, new.email)
           is distinct from
           (old.name, old.type, old.route_key, old.permissions, old.portal_user_id, old.email) then
      raise exception 'forbidden' using errcode = 'insufficient_privilege';
    end if;
  end if;
  return coalesce(new, old);
end $$;
drop trigger if exists guard_portal_write on public.portals;
create trigger guard_portal_write before insert or update or delete on public.portals
  for each row execute function app.guard_portal_write();

-- portals.create may insert a row (the API still does the auth-user side);
-- portals.disable may flip status. The existing portals_write policy
-- (portals.update, all operations) stays.
drop policy if exists portals_create on public.portals;
create policy portals_create on public.portals for insert with check (app.has_perm('portals.create'));
drop policy if exists portals_disable on public.portals;
create policy portals_disable on public.portals for update
  using (app.has_perm('portals.disable')) with check (app.has_perm('portals.disable'));

-- ── Roles: per-operation keys + anti-escalation ───────────────────────────
drop policy if exists roles_create on public.roles;
create policy roles_create on public.roles for insert with check (app.has_perm('roles.create'));
drop policy if exists roles_delete on public.roles;
create policy roles_delete on public.roles for delete using (app.has_perm('roles.delete'));

create or replace function app.guard_role_write() returns trigger
language plpgsql as $$
begin
  -- Direct database sessions (provisioning, migrations) carry no JWT.
  if app.jwt_role() = 'service_role' or nullif(current_setting('request.jwt.claims', true), '') is null then
    return coalesce(new, old);
  end if;
  if tg_op in ('UPDATE', 'DELETE') and not app.caller_holds_all(old.permissions) then
    raise exception 'that role holds access you do not have' using errcode = 'insufficient_privilege';
  end if;
  if tg_op in ('INSERT', 'UPDATE') and not app.caller_holds_all(new.permissions) then
    raise exception 'cannot grant a permission you do not hold' using errcode = 'insufficient_privilege';
  end if;
  return coalesce(new, old);
end $$;
drop trigger if exists guard_role_write on public.roles;
create trigger guard_role_write before insert or update or delete on public.roles
  for each row execute function app.guard_role_write();

-- ── permissions.view: who holds what ──────────────────────────────────────
create or replace function public.member_access_list()
returns table (
  membership_id uuid, email text, full_name text, role text, status text,
  extra_permissions text[], effective_permissions text[]
) language plpgsql stable security definer set search_path = public, app as $fn$
begin
  if not (app.has_perm('permissions.view') or app.has_perm('permissions.assign')) then
    raise exception 'forbidden' using errcode = 'insufficient_privilege';
  end if;
  return query
    select m.id, m.email, m.full_name, m.role::text, m.status::text, m.extra_permissions,
           app.membership_effective_permissions(m.role::text, m.extra_permissions, m.id)
      from public.memberships m
     order by m.created_at;
end $fn$;
revoke all on function public.member_access_list() from public;
grant execute on function public.member_access_list() to authenticated, service_role;

-- ── Tables / Deals / Suppliers / Purchases: per-operation keys ─────────────
drop policy if exists tables_create on public.restaurant_tables;
create policy tables_create on public.restaurant_tables for insert with check (app.has_perm('tables.create'));

drop policy if exists deals_create on public.deals;
create policy deals_create on public.deals for insert with check (app.has_perm('deals.create'));
drop policy if exists deals_archive on public.deals;
create policy deals_archive on public.deals for delete using (app.has_perm('deals.archive'));

-- Taking a deal off sale / back on sale without full edit rights.
create or replace function public.set_deal_available(p_deal_id uuid, p_available boolean)
returns void language plpgsql security definer set search_path = public, app as $fn$
begin
  if not (app.has_perm('deals.archive') or app.has_perm('deals.update')) then
    raise exception 'forbidden' using errcode = 'insufficient_privilege';
  end if;
  update public.deals set is_available = p_available where id = p_deal_id;
  if not found then raise exception 'deal_not_found' using errcode = 'no_data_found'; end if;
  perform app.log_action('deal.availability', 'deals', p_deal_id::text, null,
                         jsonb_build_object('is_available', p_available));
end $fn$;
revoke all on function public.set_deal_available(uuid, boolean) from public;
grant execute on function public.set_deal_available(uuid, boolean) to authenticated, service_role;

drop policy if exists supplier_create on public.suppliers;
create policy supplier_create on public.suppliers for insert with check (app.has_perm('supplier.create'));
drop policy if exists supplier_update on public.suppliers;
create policy supplier_update on public.suppliers for update
  using (app.has_perm('supplier.update')) with check (app.has_perm('supplier.update'));

drop policy if exists purchases_create on public.purchase_orders;
create policy purchases_create on public.purchase_orders for insert
  with check (app.has_perm('purchases.create') and status = 'draft');
drop policy if exists purchases_create_lines on public.purchase_order_lines;
create policy purchases_create_lines on public.purchase_order_lines for insert
  with check (app.has_perm('purchases.create') and exists (
    select 1 from public.purchase_orders po where po.id = purchase_order_id and po.status = 'draft'));
-- Only unsent drafts can be deleted by purchases.delete alone.
drop policy if exists purchases_delete on public.purchase_orders;
create policy purchases_delete on public.purchase_orders for delete
  using (app.has_perm('purchases.delete') and status = 'draft' and sent_at is null);

-- ── Menu variants: variants.* keys ────────────────────────────────────────
drop policy if exists variants_read on public.menu_variants;
create policy variants_read on public.menu_variants for select using (
  app.has_perm('variants.view') or app.has_perm('availability.view')
  or app.has_perm('kitchen.manage_availability') or app.has_perm('kitchen.record_waste'));
drop policy if exists variants_create on public.menu_variants;
create policy variants_create on public.menu_variants for insert with check (app.has_perm('variants.create'));
drop policy if exists variants_update on public.menu_variants;
create policy variants_update on public.menu_variants for update
  using (app.has_perm('variants.update')) with check (app.has_perm('variants.update'));
-- Variant names need their parent item name alongside them.
drop policy if exists variants_item_read on public.menu_items;
create policy variants_item_read on public.menu_items for select using (
  app.has_perm('variants.view') or app.has_perm('availability.view')
  or app.has_perm('kitchen.manage_availability') or app.has_perm('kitchen.record_waste'));

-- Archiving hides a variant from sale without deleting its sales history.
create or replace function public.set_variant_archived(p_variant_id uuid, p_archived boolean)
returns void language plpgsql security definer set search_path = public, app as $fn$
begin
  if not (app.has_perm('variants.archive') or app.has_perm('menu.update')) then
    raise exception 'forbidden' using errcode = 'insufficient_privilege';
  end if;
  update public.menu_variants set is_available = not p_archived where id = p_variant_id;
  if not found then raise exception 'variant_not_found' using errcode = 'no_data_found'; end if;
  perform app.log_action('variant.archive', 'menu_variants', p_variant_id::text, null,
                         jsonb_build_object('archived', p_archived));
end $fn$;
revoke all on function public.set_variant_archived(uuid, boolean) from public;
grant execute on function public.set_variant_archived(uuid, boolean) to authenticated, service_role;

-- ── Payments: adjust + reconcile ──────────────────────────────────────────
alter table public.payments add column if not exists reconciled_at timestamptz;
alter table public.payments add column if not exists reconciled_by uuid;

-- Correct a mis-keyed payment method/reference. Amounts never change here —
-- that's a refund or void.
create or replace function public.adjust_payment(
  p_payment_id uuid, p_method text, p_reference text, p_reason text
) returns void language plpgsql security definer set search_path = public, app as $fn$
declare v_pay public.payments;
begin
  if not app.has_perm('payments.adjust') then
    raise exception 'forbidden' using errcode = 'insufficient_privilege';
  end if;
  if coalesce(trim(p_reason), '') = '' then
    raise exception 'reason_required' using errcode = 'check_violation';
  end if;
  if coalesce(p_method, '') not in ('cash', 'card', 'mobile', 'online', 'wallet', 'other') then
    raise exception 'bad_method' using errcode = 'check_violation';
  end if;
  select * into v_pay from public.payments where id = p_payment_id;
  if not found then raise exception 'payment_not_found' using errcode = 'no_data_found'; end if;
  if v_pay.status = 'voided' then
    raise exception 'payment_voided' using errcode = 'check_violation';
  end if;
  if v_pay.reconciled_at is not null then
    raise exception 'payment_reconciled' using errcode = 'check_violation';
  end if;
  update public.payments
     set method = p_method, reference = nullif(trim(p_reference), '')
   where id = p_payment_id;
  perform app.log_action('payment.adjusted', 'payments', p_payment_id::text,
                         jsonb_build_object('method', v_pay.method, 'reference', v_pay.reference),
                         jsonb_build_object('method', p_method, 'reference', p_reference, 'reason', p_reason));
end $fn$;
revoke all on function public.adjust_payment(uuid, text, text, text) from public;
grant execute on function public.adjust_payment(uuid, text, text, text) to authenticated, service_role;

-- Totals per method for one business day, with how much is already reconciled.
create or replace function public.payment_reconciliation(p_date date)
returns table (method text, payment_count bigint, captured_cents bigint, refunded_cents bigint,
               net_cents bigint, reconciled_count bigint, unreconciled_count bigint)
language plpgsql stable security definer set search_path = public, app as $fn$
begin
  if not (app.has_perm('payments.reconcile') or app.has_perm('payments.view')) then
    raise exception 'forbidden' using errcode = 'insufficient_privilege';
  end if;
  return query
    select p.method,
           count(*),
           coalesce(sum(p.amount_cents), 0)::bigint,
           coalesce(sum(p.refunded_cents), 0)::bigint,
           coalesce(sum(p.amount_cents - p.refunded_cents), 0)::bigint,
           count(*) filter (where p.reconciled_at is not null),
           count(*) filter (where p.reconciled_at is null)
      from public.payments p
     where p.status <> 'voided'
       and p.created_at >= p_date::timestamptz
       and p.created_at < (p_date + 1)::timestamptz
     group by p.method
     order by p.method;
end $fn$;
revoke all on function public.payment_reconciliation(date) from public;
grant execute on function public.payment_reconciliation(date) to authenticated, service_role;

create or replace function public.reconcile_payments(p_date date, p_method text)
returns int language plpgsql security definer set search_path = public, app as $fn$
declare v_n int;
begin
  if not app.has_perm('payments.reconcile') then
    raise exception 'forbidden' using errcode = 'insufficient_privilege';
  end if;
  update public.payments
     set reconciled_at = now(), reconciled_by = app.jwt_sub()
   where method = p_method and status <> 'voided' and reconciled_at is null
     and created_at >= p_date::timestamptz and created_at < (p_date + 1)::timestamptz;
  get diagnostics v_n = row_count;
  perform app.log_action('payments.reconciled', 'payments', p_date::text, null,
                         jsonb_build_object('method', p_method, 'count', v_n));
  return v_n;
end $fn$;
revoke all on function public.reconcile_payments(date, text) from public;
grant execute on function public.reconcile_payments(date, text) to authenticated, service_role;

-- ── finance.reconcile: cash counts ────────────────────────────────────────
create table if not exists public.cash_counts (
  id               uuid primary key default gen_random_uuid(),
  business_date    date not null,
  opening_cents    int not null default 0,
  counted_cents    int not null,
  expected_cents   int not null,
  difference_cents int not null,
  note             text,
  counted_by       uuid,
  counted_by_email text,
  created_at       timestamptz not null default now()
);
create index if not exists cash_counts_date_idx on public.cash_counts(business_date desc, created_at desc);
alter table public.cash_counts enable row level security;
drop policy if exists staff_read on public.cash_counts;
create policy staff_read on public.cash_counts for select
  using (app.has_perm('finance.reconcile') or app.has_perm('finance.view') or app.can_write());

-- Count the drawer at any time (shift change, mid-day, before closing) and
-- see it against what the till should hold: opening float + cash taken.
create or replace function public.record_cash_count(
  p_business_date date, p_opening_cents int, p_counted_cents int, p_note text default null
) returns public.cash_counts language plpgsql security definer set search_path = public, app as $fn$
declare v_expected int; v_row public.cash_counts;
begin
  if not app.has_perm('finance.reconcile') then
    raise exception 'forbidden' using errcode = 'insufficient_privilege';
  end if;
  if coalesce(p_counted_cents, -1) < 0 or coalesce(p_opening_cents, 0) < 0 then
    raise exception 'bad_amount' using errcode = 'check_violation';
  end if;
  v_expected := coalesce(p_opening_cents, 0)
              + coalesce((app.day_sales(p_business_date)->>'cash_in_cents')::int, 0);
  insert into public.cash_counts
    (business_date, opening_cents, counted_cents, expected_cents, difference_cents, note, counted_by, counted_by_email)
  values
    (p_business_date, coalesce(p_opening_cents, 0), p_counted_cents, v_expected, p_counted_cents - v_expected,
     nullif(trim(p_note), ''), app.jwt_sub(),
     nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'email')
  returning * into v_row;
  perform app.log_action('cash.counted', 'cash_counts', v_row.id::text, null,
                         jsonb_build_object('counted', p_counted_cents, 'expected', v_expected));
  return v_row;
end $fn$;
revoke all on function public.record_cash_count(date, int, int, text) from public;
grant execute on function public.record_cash_count(date, int, int, text) to authenticated, service_role;

-- ── finance.manage_costs: ingredient unit cost ────────────────────────────
create or replace function public.set_ingredient_cost(p_item_id uuid, p_cost_cents_per_base_unit numeric)
returns void language plpgsql security definer set search_path = public, app as $fn$
declare v_old numeric;
begin
  if not app.has_perm('finance.manage_costs') then
    raise exception 'forbidden' using errcode = 'insufficient_privilege';
  end if;
  if coalesce(p_cost_cents_per_base_unit, -1) < 0 then
    raise exception 'bad_cost' using errcode = 'check_violation';
  end if;
  select cost_cents_per_base_unit into v_old from public.inventory_items where id = p_item_id;
  if not found then raise exception 'item_not_found' using errcode = 'no_data_found'; end if;
  update public.inventory_items set cost_cents_per_base_unit = p_cost_cents_per_base_unit where id = p_item_id;
  perform app.log_action('inventory.cost_changed', 'inventory_items', p_item_id::text,
                         jsonb_build_object('cost_cents_per_base_unit', v_old),
                         jsonb_build_object('cost_cents_per_base_unit', p_cost_cents_per_base_unit));
end $fn$;
revoke all on function public.set_ingredient_cost(uuid, numeric) from public;
grant execute on function public.set_ingredient_cost(uuid, numeric) to authenticated, service_role;

-- Cost managers need to see the items they price.
drop policy if exists cost_read on public.inventory_items;
create policy cost_read on public.inventory_items for select using (app.has_perm('finance.manage_costs'));

-- ── Attendance: dashboard, history, corrections ───────────────────────────
create or replace function public.attendance_dashboard(p_date date default null)
returns table (total_staff bigint, present bigint, late bigint, absent bigint, on_leave bigint,
               checked_out bigint, not_marked bigint, worked_minutes bigint)
language plpgsql stable security definer set search_path = public, app as $fn$
declare v_date date := coalesce(p_date, current_date);
begin
  if not (app.has_perm('attendance.view_dashboard') or app.has_perm('attendance.view')) then
    raise exception 'forbidden' using errcode = 'insufficient_privilege';
  end if;
  return query
    with staff as (select id from public.memberships where status = 'active' and role <> 'owner'),
    day as (
      select a.* from public.attendance a
       where coalesce(a.business_date, a.clock_in::date) = v_date
    )
    select (select count(*) from staff),
           count(*) filter (where d.status in ('present', 'late', 'early_departure', 'half_day', 'incomplete')),
           count(*) filter (where d.status = 'late'),
           count(*) filter (where d.status = 'absent'),
           count(*) filter (where d.status in ('leave', 'off')),
           count(*) filter (where d.clock_out is not null),
           (select count(*) from staff s where not exists (
              select 1 from day d2 where d2.membership_id = s.id)),
           coalesce(sum(d.worked_minutes), 0)::bigint
      from day d;
end $fn$;
revoke all on function public.attendance_dashboard(date) from public;
grant execute on function public.attendance_dashboard(date) to authenticated, service_role;

create or replace function public.attendance_history(p_from date, p_to date, p_membership_id uuid default null)
returns table (id uuid, membership_id uuid, full_name text, email text, business_date date,
               clock_in timestamptz, clock_out timestamptz, status text, late_minutes int,
               worked_minutes int, overtime_minutes int, source text)
language plpgsql stable security definer set search_path = public, app as $fn$
declare v_self boolean := p_membership_id is not null and p_membership_id = app.my_membership_id();
begin
  if not (app.has_perm('attendance.view_history') or app.has_perm('attendance.view_reports')
          or app.has_perm('attendance.view_employee_reports')
          or (v_self and app.has_perm('attendance.view_own'))) then
    raise exception 'forbidden' using errcode = 'insufficient_privilege';
  end if;
  return query
    select a.id, a.membership_id, m.full_name, m.email,
           coalesce(a.business_date, a.clock_in::date), a.clock_in, a.clock_out, a.status,
           a.late_minutes, a.worked_minutes, a.overtime_minutes, a.source
      from public.attendance a
      join public.memberships m on m.id = a.membership_id
     where coalesce(a.business_date, a.clock_in::date) between p_from and p_to
       and (p_membership_id is null or a.membership_id = p_membership_id)
     order by coalesce(a.business_date, a.clock_in::date) desc, m.full_name
     limit 1000;
end $fn$;
revoke all on function public.attendance_history(date, date, uuid) from public;
grant execute on function public.attendance_history(date, date, uuid) to authenticated, service_role;

create table if not exists public.attendance_corrections (
  id                  uuid primary key default gen_random_uuid(),
  attendance_id       uuid references public.attendance(id) on delete cascade,
  membership_id       uuid not null references public.memberships(id) on delete cascade,
  business_date       date not null,
  requested_clock_in  timestamptz,
  requested_clock_out timestamptz,
  reason              text not null,
  status              text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  requested_by        uuid,
  requested_by_email  text,
  reviewed_by         uuid,
  reviewed_by_email   text,
  review_note         text,
  created_at          timestamptz not null default now(),
  reviewed_at         timestamptz
);
create index if not exists attendance_corrections_status_idx on public.attendance_corrections(status, created_at desc);
alter table public.attendance_corrections enable row level security;
drop policy if exists staff_read on public.attendance_corrections;
create policy staff_read on public.attendance_corrections for select using (
  app.has_perm('attendance.approve_correction') or app.has_perm('attendance.correct')
  or app.has_perm('attendance.request_correction') or app.has_perm('attendance.view')
  or membership_id = app.my_membership_id() or app.can_write());

-- Apply clock times to a member's day (creating the row if the day has none)
-- and let the existing attendance engine recompute late/worked minutes.
create or replace function app.apply_attendance_times(
  p_membership_id uuid, p_date date, p_clock_in timestamptz, p_clock_out timestamptz
) returns uuid language plpgsql security definer set search_path = public, app as $fn$
declare v_id uuid;
begin
  if p_clock_in is not null and p_clock_out is not null and p_clock_out <= p_clock_in then
    raise exception 'clock_out_before_clock_in' using errcode = 'check_violation';
  end if;
  select id into v_id from public.attendance
   where membership_id = p_membership_id and coalesce(business_date, clock_in::date) = p_date
   order by clock_in nulls last limit 1;
  if v_id is null then
    insert into public.attendance (membership_id, business_date, clock_in, clock_out, source)
    values (p_membership_id, p_date, p_clock_in, p_clock_out, 'manager')
    returning id into v_id;
  else
    update public.attendance
       set clock_in = coalesce(p_clock_in, clock_in),
           clock_out = coalesce(p_clock_out, clock_out),
           source = 'manager'
     where id = v_id;
  end if;
  begin
    perform app.recompute_attendance(v_id);
  exception when undefined_function then null;
  end;
  return v_id;
end $fn$;

create or replace function public.request_attendance_correction(
  p_membership_id uuid, p_business_date date, p_clock_in timestamptz, p_clock_out timestamptz, p_reason text
) returns uuid language plpgsql security definer set search_path = public, app as $fn$
declare v_self boolean := p_membership_id = app.my_membership_id(); v_att uuid; v_id uuid;
begin
  if not (app.has_perm('attendance.request_correction')
          or (v_self and app.has_perm('attendance.view_own'))) then
    raise exception 'forbidden' using errcode = 'insufficient_privilege';
  end if;
  if coalesce(trim(p_reason), '') = '' then
    raise exception 'reason_required' using errcode = 'check_violation';
  end if;
  if p_clock_in is null and p_clock_out is null then
    raise exception 'times_required' using errcode = 'check_violation';
  end if;
  select id into v_att from public.attendance
   where membership_id = p_membership_id and coalesce(business_date, clock_in::date) = p_business_date
   limit 1;
  insert into public.attendance_corrections
    (attendance_id, membership_id, business_date, requested_clock_in, requested_clock_out, reason,
     requested_by, requested_by_email)
  values
    (v_att, p_membership_id, p_business_date, p_clock_in, p_clock_out, trim(p_reason), app.jwt_sub(),
     nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'email')
  returning id into v_id;
  perform app.log_action('attendance.correction_requested', 'attendance_corrections', v_id::text);
  return v_id;
end $fn$;
revoke all on function public.request_attendance_correction(uuid, date, timestamptz, timestamptz, text) from public;
grant execute on function public.request_attendance_correction(uuid, date, timestamptz, timestamptz, text) to authenticated, service_role;

create or replace function public.review_attendance_correction(p_correction_id uuid, p_approve boolean, p_note text default null)
returns void language plpgsql security definer set search_path = public, app as $fn$
declare v_c public.attendance_corrections;
begin
  if not app.has_perm('attendance.approve_correction') then
    raise exception 'forbidden' using errcode = 'insufficient_privilege';
  end if;
  select * into v_c from public.attendance_corrections where id = p_correction_id for update;
  if not found then raise exception 'correction_not_found' using errcode = 'no_data_found'; end if;
  if v_c.status <> 'pending' then
    raise exception 'already_reviewed' using errcode = 'check_violation';
  end if;
  if v_c.requested_by = app.jwt_sub() then
    raise exception 'cannot_review_own_request' using errcode = 'insufficient_privilege';
  end if;
  if p_approve then
    perform app.apply_attendance_times(v_c.membership_id, v_c.business_date,
                                       v_c.requested_clock_in, v_c.requested_clock_out);
  end if;
  update public.attendance_corrections
     set status = case when p_approve then 'approved' else 'rejected' end,
         reviewed_by = app.jwt_sub(),
         reviewed_by_email = nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'email',
         review_note = nullif(trim(p_note), ''),
         reviewed_at = now()
   where id = p_correction_id;
  perform app.log_action(case when p_approve then 'attendance.correction_approved'
                              else 'attendance.correction_rejected' end,
                         'attendance_corrections', p_correction_id::text);
end $fn$;
revoke all on function public.review_attendance_correction(uuid, boolean, text) from public;
grant execute on function public.review_attendance_correction(uuid, boolean, text) to authenticated, service_role;

-- attendance.correct: edit a day's times directly, no request/approval step.
create or replace function public.correct_attendance(
  p_membership_id uuid, p_business_date date, p_clock_in timestamptz, p_clock_out timestamptz, p_reason text
) returns uuid language plpgsql security definer set search_path = public, app as $fn$
declare v_id uuid;
begin
  if not app.has_perm('attendance.correct') then
    raise exception 'forbidden' using errcode = 'insufficient_privilege';
  end if;
  if coalesce(trim(p_reason), '') = '' then
    raise exception 'reason_required' using errcode = 'check_violation';
  end if;
  v_id := app.apply_attendance_times(p_membership_id, p_business_date, p_clock_in, p_clock_out);
  perform app.log_action('attendance.corrected', 'attendance', v_id::text, null,
                         jsonb_build_object('clock_in', p_clock_in, 'clock_out', p_clock_out, 'reason', p_reason));
  return v_id;
end $fn$;
revoke all on function public.correct_attendance(uuid, date, timestamptz, timestamptz, text) from public;
grant execute on function public.correct_attendance(uuid, date, timestamptz, timestamptz, text) to authenticated, service_role;

-- Names for the correction/history pickers without full staff.view.
create or replace function public.attendance_staff_list()
returns table (membership_id uuid, full_name text, email text, role text)
language plpgsql stable security definer set search_path = public, app as $fn$
begin
  if not (app.has_perm('attendance.view') or app.has_perm('attendance.view_history')
          or app.has_perm('attendance.view_reports') or app.has_perm('attendance.view_employee_reports')
          or app.has_perm('attendance.correct') or app.has_perm('attendance.request_correction')
          or app.has_perm('attendance.approve_correction')) then
    raise exception 'forbidden' using errcode = 'insufficient_privilege';
  end if;
  return query
    select m.id, m.full_name, m.email, m.role::text
      from public.memberships m
     where m.status = 'active' and m.role <> 'owner'
     order by coalesce(m.full_name, m.email);
end $fn$;
revoke all on function public.attendance_staff_list() from public;
grant execute on function public.attendance_staff_list() to authenticated, service_role;

-- ── Reviews: respond, moderate, analytics ─────────────────────────────────
alter table public.feedback add column if not exists response       text;
alter table public.feedback add column if not exists responded_at   timestamptz;
alter table public.feedback add column if not exists responded_by   text;
alter table public.feedback add column if not exists is_hidden      boolean not null default false;
alter table public.feedback add column if not exists moderation_note text;
alter table public.feedback add column if not exists moderated_at   timestamptz;
alter table public.feedback add column if not exists moderated_by   text;

create or replace function public.respond_to_review(p_feedback_id uuid, p_response text)
returns void language plpgsql security definer set search_path = public, app as $fn$
begin
  if not app.has_perm('reviews.respond') then
    raise exception 'forbidden' using errcode = 'insufficient_privilege';
  end if;
  update public.feedback
     set response = nullif(trim(p_response), ''),
         responded_at = case when nullif(trim(p_response), '') is null then null else now() end,
         responded_by = nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'email'
   where id = p_feedback_id;
  if not found then raise exception 'review_not_found' using errcode = 'no_data_found'; end if;
  perform app.log_action('review.responded', 'feedback', p_feedback_id::text);
end $fn$;
revoke all on function public.respond_to_review(uuid, text) from public;
grant execute on function public.respond_to_review(uuid, text) to authenticated, service_role;

create or replace function public.moderate_review(p_feedback_id uuid, p_hidden boolean, p_note text default null)
returns void language plpgsql security definer set search_path = public, app as $fn$
begin
  if not app.has_perm('reviews.moderate') then
    raise exception 'forbidden' using errcode = 'insufficient_privilege';
  end if;
  update public.feedback
     set is_hidden = p_hidden,
         moderation_note = nullif(trim(p_note), ''),
         moderated_at = now(),
         moderated_by = nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'email'
   where id = p_feedback_id;
  if not found then raise exception 'review_not_found' using errcode = 'no_data_found'; end if;
  perform app.log_action(case when p_hidden then 'review.hidden' else 'review.restored' end,
                         'feedback', p_feedback_id::text);
end $fn$;
revoke all on function public.moderate_review(uuid, boolean, text) from public;
grant execute on function public.moderate_review(uuid, boolean, text) to authenticated, service_role;

-- Hidden (moderated) reviews are excluded from the numbers.
create or replace function public.review_analytics(p_from timestamptz, p_to timestamptz)
returns jsonb language plpgsql stable security definer set search_path = public, app as $fn$
declare v jsonb;
begin
  if not app.has_perm('reviews.analytics') then
    raise exception 'forbidden' using errcode = 'insufficient_privilege';
  end if;
  with f as (
    select * from public.feedback
     where not is_hidden and created_at >= p_from and created_at < p_to
  )
  select jsonb_build_object(
    'count', (select count(*) from f),
    'avg_overall', (select round(avg(overall)::numeric, 2) from f),
    'avg_food', (select round(avg(food)::numeric, 2) from f),
    'avg_service', (select round(avg(service)::numeric, 2) from f),
    'avg_cleanliness', (select round(avg(cleanliness)::numeric, 2) from f),
    'avg_speed', (select round(avg(speed)::numeric, 2) from f),
    'avg_ambiance', (select round(avg(ambiance)::numeric, 2) from f),
    'responded', (select count(*) from f where response is not null),
    'by_star', (select coalesce(jsonb_object_agg(overall, n), '{}'::jsonb)
                  from (select overall, count(*) n from f group by overall) s),
    'by_week', (select coalesce(jsonb_agg(w order by w->>'week'), '[]'::jsonb) from (
                  select jsonb_build_object('week', to_char(date_trunc('week', created_at), 'YYYY-MM-DD'),
                                            'count', count(*), 'avg', round(avg(overall)::numeric, 2)) w
                    from f group by date_trunc('week', created_at)) x)
  ) into v;
  return v;
end $fn$;
revoke all on function public.review_analytics(timestamptz, timestamptz) from public;
grant execute on function public.review_analytics(timestamptz, timestamptz) to authenticated, service_role;

-- ── Customers ─────────────────────────────────────────────────────────────
create table if not exists public.customers (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  phone      text,
  email      text,
  birthday   date,
  tags       text[] not null default '{}',
  notes      text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists customers_phone_idx on public.customers(phone);
create index if not exists customers_name_idx on public.customers(lower(name));
alter table public.customers enable row level security;
drop policy if exists staff_read on public.customers;
create policy staff_read on public.customers for select using (app.has_perm('customers.view') or app.can_write());
drop policy if exists customers_create on public.customers;
create policy customers_create on public.customers for insert with check (app.has_perm('customers.create') or app.can_write());
drop policy if exists customers_update on public.customers;
create policy customers_update on public.customers for update
  using (app.has_perm('customers.update') or app.can_write())
  with check (app.has_perm('customers.update') or app.can_write());
drop policy if exists customers_delete on public.customers;
create policy customers_delete on public.customers for delete using (app.can_write());

-- Visit history comes from reservations matched by phone number.
create or replace function public.customer_stats()
returns table (customer_id uuid, reservations bigint, last_reservation_at timestamptz, no_shows bigint)
language plpgsql stable security definer set search_path = public, app as $fn$
begin
  if not (app.has_perm('customers.view') or app.can_write()) then
    raise exception 'forbidden' using errcode = 'insufficient_privilege';
  end if;
  return query
    select c.id, count(r.id), max(r.reserved_at), count(r.id) filter (where r.status = 'no_show')
      from public.customers c
      left join public.reservations r
        on c.phone is not null and length(trim(c.phone)) > 0
       and regexp_replace(r.phone, '\D', '', 'g') = regexp_replace(c.phone, '\D', '', 'g')
     group by c.id;
end $fn$;
revoke all on function public.customer_stats() from public;
grant execute on function public.customer_stats() to authenticated, service_role;

do $$
declare t text;
begin
  foreach t in array array['customers', 'cash_counts', 'attendance_corrections'] loop
    execute format('drop trigger if exists audit on public.%I', t);
    begin
      execute format('create trigger audit after insert or update or delete on public.%I
                      for each row execute function app.audit_row()', t);
    exception when undefined_function then null;
    end;
  end loop;
end $$;

-- ── Permission catalog labels for delegated Roles / Portal Management ────
-- permission_catalog was readable by staff members only; a custom portal
-- granted roles.view, portals.view or permissions.view needs the labels to
-- show and pick permissions. Labels only — nothing sensitive.
drop policy if exists catalog_read_delegated on public.permission_catalog;
create policy catalog_read_delegated on public.permission_catalog for select using (
  app.has_perm('roles.view') or app.has_perm('portals.view') or app.has_perm('permissions.view'));

-- ════════════════════════════════════════════════════════════════════════════
-- 0059 — retire Customers / Roles & Access options (verbatim from tenant-migrations/0059)
-- ════════════════════════════════════════════════════════════════════════════
-- ============================================================================
-- Tenant delta 0059 — retire the Customers and Roles & Access portal options.
--
-- The owner removed the Customers, Reservations and Roles & Access sections
-- (and Assign staff) from the product. Reservations had no permission keys
-- of its own (it used tables.*, which still drive Tables & QR codes), so
-- only these catalog rows go — Create Portal no longer offers them.
-- permissions.assign stays: the Staff screen's role change uses it.
--
-- Any portal still holding a retired key has it stripped, so nothing keeps
-- an invisible grant. The customers table and the role presets themselves
-- are left in place (no data is deleted).
-- ============================================================================

delete from public.permission_catalog
 where key in ('customers.view', 'customers.create', 'customers.update',
               'roles.view', 'roles.create', 'roles.update', 'roles.delete',
               'permissions.view');

update public.portals
   set permissions = array(
         select k from unnest(permissions) as k
          where k not in ('customers.view', 'customers.create', 'customers.update',
                          'roles.view', 'roles.create', 'roles.update', 'roles.delete',
                          'permissions.view'))
 where permissions && array['customers.view', 'customers.create', 'customers.update',
                            'roles.view', 'roles.create', 'roles.update', 'roles.delete',
                            'permissions.view'];

-- ════════════════════════════════════════════════════════════════════════════
-- 0060_availability_automation (verbatim from tenant-migrations)
-- ════════════════════════════════════════════════════════════════════════════
-- ============================================================================
-- Tenant delta 0060 — Food availability automation: scoped priority
-- allocation, explicit ON/OFF setting, order-time enforcement.
--
-- Extends the existing engine (0052 recipe-driven availability, 0054
-- priority waterfall) — it does not add a second one. product_availability
-- stays the single authoritative result every surface reads (Kitchen, Menu,
-- POS, customer storefront), and its realtime publication (0052) stays the
-- notification path.
--
-- What changes:
--   1. business_settings.priority_allocation_enabled — the explicit
--      Priority Allocation ON/OFF switch. Before this, allocation silently
--      switched on whenever any product_priority row existed. Existing
--      tenants keep today's behavior (ON iff they had priorities).
--   2. The waterfall is SCOPED: a stock/recipe/priority change reallocates
--      only the connected group of products that share ingredients with
--      what changed (transitive closure over recipe_components), not every
--      product in the restaurant. Products outside that group can't be
--      affected — they share no ingredient with it.
--   3. place_order() lines are checked against the authoritative allocated
--      quantity (BEFORE INSERT on order_lines). Raw-stock checks alone let a
--      lower-priority product consume stock the waterfall had allocated to a
--      higher-priority one. Existing orders/KOTs are never touched.
--   4. Kitchen actions that work through the same chain instead of a
--      separate manual count: record_dish_waste() deducts the dish's recipe
--      ingredients (so availability recalculates), set_item_available() is
--      the manual take-off-sale switch for items without variants.
-- ============================================================================

-- ── 1. Setting ────────────────────────────────────────────────────────────
alter table public.business_settings
  add column if not exists priority_allocation_enabled boolean not null default false;
update public.business_settings
   set priority_allocation_enabled = true
 where id and exists (select 1 from public.product_priority);

create or replace function app.priority_allocation_on() returns boolean
language sql stable security definer set search_path = public, app as $$
  select coalesce((select priority_allocation_enabled from public.business_settings where id), false)
$$;

-- ── 2. Dependency scope ───────────────────────────────────────────────────
-- Every ingredient connected to the seed set: an ingredient pulls in every
-- product whose recipe uses it, and each such product pulls in all of its
-- own ingredients, repeated to a fixed point. A seed ingredient used only
-- by a REQUIRED modifier also pulls in that item's recipe ingredients, so
-- the item is reallocated against the right pool.
create or replace function app.availability_scope(p_ingredient_ids uuid[])
returns uuid[] language sql stable security definer set search_path = public, app as $$
  with recursive seed(id) as (
    select unnest(p_ingredient_ids)
    union
    select rc.inventory_item_id
      from public.modifier_recipe_components mrc
      join public.modifier_options mo on mo.id = mrc.modifier_option_id
      join public.modifier_groups mg on mg.id = mo.group_id and mg.min_select >= 1
      join public.recipe_components rc on rc.menu_item_id = mg.menu_item_id
     where mrc.inventory_item_id = any(p_ingredient_ids)
  ),
  ing(id) as (
    select id from seed
    union
    select rc2.inventory_item_id
      from ing
      join public.recipe_components rc1 on rc1.inventory_item_id = ing.id
      join public.recipe_components rc2 on rc2.menu_item_id = rc1.menu_item_id
  )
  select coalesce(array_agg(distinct id), '{}'::uuid[]) from ing
$$;

-- Every ingredient an item's availability depends on (its recipes plus its
-- required modifier groups' options).
create or replace function app.item_ingredients(p_menu_item_id uuid)
returns uuid[] language sql stable security definer set search_path = public, app as $$
  select coalesce(array_agg(distinct x), '{}'::uuid[]) from (
    select inventory_item_id as x from public.recipe_components where menu_item_id = p_menu_item_id
    union
    select mrc.inventory_item_id
      from public.modifier_recipe_components mrc
      join public.modifier_options mo on mo.id = mrc.modifier_option_id
      join public.modifier_groups mg on mg.id = mo.group_id
     where mg.menu_item_id = p_menu_item_id and mg.min_select >= 1
  ) s
$$;

-- ── 3. Scoped waterfall ───────────────────────────────────────────────────
-- Same greedy allocation as 0054 (critical → high → medium → low by rank,
-- then unprioritized alphabetically; each product's claim is deducted from
-- the pool before the next is computed), restricted to the connected
-- scope. p_ingredient_ids null = the whole restaurant (manual recalculation
-- and turning the setting on).
drop function if exists app.recalc_priority_allocation(text, text);
create or replace function app.recalc_priority_allocation(
  p_trigger_type text default 'priority_reallocation',
  p_trigger_reference text default null,
  p_ingredient_ids uuid[] default null
) returns void language plpgsql security definer set search_path = public, app as $fn$
declare
  v_scope uuid[];
  v_prod record;
  v_r record;
  v_effective_variant uuid;
  v_has_variant_recipe boolean;
begin
  if not app.priority_allocation_on() then
    return;
  end if;

  -- One waterfall at a time per restaurant: runs share priority_stock_pool
  -- rows, so concurrent orders reallocating overlapping scopes serialize
  -- here instead of interleaving (or deadlocking) on the pool.
  perform pg_advisory_xact_lock(hashtext('app.recalc_priority_allocation'));

  if p_ingredient_ids is null then
    select coalesce(array_agg(id), '{}'::uuid[]) into v_scope from public.inventory_items;
  else
    v_scope := app.availability_scope(p_ingredient_ids);
  end if;
  if cardinality(v_scope) = 0 then
    return;
  end if;

  delete from public.priority_stock_pool where inventory_item_id = any(v_scope);
  insert into public.priority_stock_pool (inventory_item_id, remaining)
    select id, greatest(stock_qty, 0) from public.inventory_items where id = any(v_scope);

  for v_prod in
    select x.menu_item_id, x.variant_id,
           case coalesce(pp.priority_level, 'unprioritized')
             when 'critical' then 0 when 'high' then 1 when 'medium' then 2 when 'low' then 3
             else 4
           end as level_rank,
           coalesce(pp.priority_rank, 999999) as rank_in_level,
           mi.name as item_name
      from (
        select distinct menu_item_id, variant_id from public.recipe_components
         where inventory_item_id = any(v_scope)
        union
        select distinct mg.menu_item_id, null::uuid
          from public.modifier_groups mg
         where mg.min_select >= 1
           and (p_ingredient_ids is null or exists (
                 select 1 from public.modifier_options mo
                   join public.modifier_recipe_components mrc on mrc.modifier_option_id = mo.id
                  where mo.group_id = mg.id and mrc.inventory_item_id = any(v_scope)))
      ) x
      join public.menu_items mi on mi.id = x.menu_item_id
      left join public.product_priority pp on pp.menu_item_id = x.menu_item_id
     order by level_rank, rank_in_level, mi.name, x.variant_id nulls first
  loop
    select * into v_r from app.compute_product_capacity(v_prod.menu_item_id, v_prod.variant_id, true);
    perform app.apply_product_availability_result(
      v_prod.menu_item_id, v_prod.variant_id, v_r.tracked, v_r.status, v_r.producible_qty,
      v_r.bottleneck_inventory_item_id, v_r.reason, p_trigger_type, p_trigger_reference, 'system'
    );

    if v_r.tracked and coalesce(v_r.producible_qty, 0) > 0 then
      if v_prod.variant_id is not null then
        select exists(select 1 from public.recipe_components
                       where menu_item_id = v_prod.menu_item_id and variant_id = v_prod.variant_id)
          into v_has_variant_recipe;
        v_effective_variant := case when v_has_variant_recipe then v_prod.variant_id else null end;
      else
        v_effective_variant := null;
      end if;

      update public.priority_stock_pool ps
         set remaining = ps.remaining - (v_r.producible_qty * rc.qty_per_unit)
        from public.recipe_components rc
       where rc.menu_item_id = v_prod.menu_item_id
         and rc.variant_id is not distinct from v_effective_variant
         and ps.inventory_item_id = rc.inventory_item_id;
    end if;
  end loop;
end;
$fn$;

-- ── 4. Triggers: ON → scoped waterfall, OFF → the targeted per-product
-- engine exactly as before ────────────────────────────────────────────────
create or replace function app.on_inventory_stock_change() returns trigger
language plpgsql security definer set search_path = public, app as $$
declare v_type text;
begin
  if new.stock_qty is distinct from old.stock_qty then
    v_type := case when new.stock_qty > old.stock_qty then 'inventory_restock' else 'inventory_consumption' end;
    if app.priority_allocation_on() then
      perform app.recalc_priority_allocation(v_type, new.id::text, array[new.id]);
    else
      perform app.recalc_products_for_ingredient(new.id, v_type, null);
    end if;
  end if;
  return new;
end;
$$;

create or replace function app.on_recipe_components_change() returns trigger
language plpgsql security definer set search_path = public, app as $$
declare v_item uuid; v_variant uuid; v_ings uuid[];
begin
  if tg_op = 'DELETE' then
    v_item := old.menu_item_id; v_variant := old.variant_id;
  else
    v_item := new.menu_item_id; v_variant := new.variant_id;
  end if;
  -- Per-product pass first: it also clears the row of a product whose last
  -- recipe line was just removed (it's no longer tracked at all).
  perform app.recalc_product_availability(v_item, v_variant, 'recipe_change', null);
  if v_variant is not null then
    perform app.recalc_product_availability(v_item, null, 'recipe_change', null);
  end if;
  if app.priority_allocation_on() then
    v_ings := app.item_ingredients(v_item);
    if tg_op in ('DELETE', 'UPDATE') then v_ings := v_ings || old.inventory_item_id; end if;
    if tg_op in ('INSERT', 'UPDATE') then v_ings := v_ings || new.inventory_item_id; end if;
    perform app.recalc_priority_allocation('recipe_change', v_item::text, v_ings);
  end if;
  return coalesce(new, old);
end;
$$;

create or replace function app.on_modifier_recipe_components_change() returns trigger
language plpgsql security definer set search_path = public, app as $$
declare v_option uuid; v_item uuid; r record;
begin
  v_option := coalesce(new.modifier_option_id, old.modifier_option_id);
  select mg.menu_item_id into v_item
    from public.modifier_options mo join public.modifier_groups mg on mg.id = mo.group_id
   where mo.id = v_option;
  if v_item is not null then
    if app.priority_allocation_on() then
      perform app.recalc_priority_allocation('recipe_change', v_item::text,
        app.item_ingredients(v_item) || coalesce(new.inventory_item_id, old.inventory_item_id));
    else
      for r in select variant_id from public.product_availability where menu_item_id = v_item loop
        perform app.recalc_product_availability(v_item, r.variant_id, 'recipe_change', null);
      end loop;
      perform app.recalc_product_availability(v_item, null, 'recipe_change', null);
    end if;
  end if;
  return coalesce(new, old);
end;
$$;

create or replace function app.on_modifier_option_availability_change() returns trigger
language plpgsql security definer set search_path = public, app as $$
declare v_item uuid; r record;
begin
  if new.is_available is distinct from old.is_available then
    select mg.menu_item_id into v_item from public.modifier_groups mg where mg.id = new.group_id;
    if v_item is not null then
      if app.priority_allocation_on() then
        perform app.recalc_priority_allocation('recipe_change', v_item::text, app.item_ingredients(v_item));
      else
        for r in select variant_id from public.product_availability where menu_item_id = v_item loop
          perform app.recalc_product_availability(v_item, r.variant_id, 'recipe_change', null);
        end loop;
        perform app.recalc_product_availability(v_item, null, 'recipe_change', null);
      end if;
    end if;
  end if;
  return new;
end;
$$;

-- ── 5. Priority management: reallocate only the changed product's group ───
create or replace function public.set_product_priority(p_menu_item_id uuid, p_priority_level text)
returns void language plpgsql security definer set search_path = public, app as $fn$
declare v_next_rank int; v_cur_level text;
begin
  if not (app.has_perm('availability.update') or app.can_write()) then
    raise exception 'forbidden' using errcode = 'insufficient_privilege';
  end if;
  if p_priority_level not in ('critical', 'high', 'medium', 'low') then
    raise exception 'bad_priority_level' using errcode = 'check_violation';
  end if;
  select priority_level into v_cur_level from public.product_priority where menu_item_id = p_menu_item_id;
  if v_cur_level is null then
    select coalesce(max(priority_rank), 0) + 1 into v_next_rank from public.product_priority where priority_level = p_priority_level;
    insert into public.product_priority (menu_item_id, priority_level, priority_rank)
    values (p_menu_item_id, p_priority_level, v_next_rank);
  elsif v_cur_level <> p_priority_level then
    select coalesce(max(priority_rank), 0) + 1 into v_next_rank from public.product_priority where priority_level = p_priority_level;
    update public.product_priority set priority_level = p_priority_level, priority_rank = v_next_rank, updated_at = now()
     where menu_item_id = p_menu_item_id;
  end if;
  perform app.recalc_priority_allocation('priority_change', p_menu_item_id::text, app.item_ingredients(p_menu_item_id));
end;
$fn$;

create or replace function public.remove_product_priority(p_menu_item_id uuid)
returns void language plpgsql security definer set search_path = public, app as $fn$
begin
  if not (app.has_perm('availability.update') or app.can_write()) then
    raise exception 'forbidden' using errcode = 'insufficient_privilege';
  end if;
  delete from public.product_priority where menu_item_id = p_menu_item_id;
  perform app.recalc_priority_allocation('priority_change', p_menu_item_id::text, app.item_ingredients(p_menu_item_id));
end;
$fn$;

create or replace function public.reorder_product_priority(p_priority_level text, p_ordered_menu_item_ids uuid[])
returns void language plpgsql security definer set search_path = public, app as $fn$
declare v_id uuid; v_rank int := 1; v_ings uuid[] := '{}';
begin
  if not (app.has_perm('availability.update') or app.can_write()) then
    raise exception 'forbidden' using errcode = 'insufficient_privilege';
  end if;
  if p_priority_level not in ('critical', 'high', 'medium', 'low') then
    raise exception 'bad_priority_level' using errcode = 'check_violation';
  end if;
  update public.product_priority set priority_rank = priority_rank + 1000000
   where priority_level = p_priority_level and menu_item_id = any(p_ordered_menu_item_ids);
  foreach v_id in array p_ordered_menu_item_ids loop
    update public.product_priority set priority_rank = v_rank, updated_at = now()
     where menu_item_id = v_id and priority_level = p_priority_level;
    v_rank := v_rank + 1;
    v_ings := v_ings || app.item_ingredients(v_id);
  end loop;
  perform app.recalc_priority_allocation('priority_change', null, v_ings);
end;
$fn$;

-- The ON/OFF switch. availability.update is the same key that already
-- governs priority configuration.
create or replace function public.set_priority_allocation(p_enabled boolean)
returns void language plpgsql security definer set search_path = public, app as $fn$
begin
  if not (app.has_perm('availability.update') or app.can_write()) then
    raise exception 'forbidden' using errcode = 'insufficient_privilege';
  end if;
  update public.business_settings set priority_allocation_enabled = coalesce(p_enabled, false) where id;
  perform app.log_action(case when p_enabled then 'availability.allocation_on' else 'availability.allocation_off' end,
                         'business_settings', 'priority_allocation_enabled');
  if p_enabled then
    perform app.recalc_priority_allocation('priority_change', 'allocation_on', null);
  else
    -- Back to every product's independent capacity.
    perform public.recalculate_all_product_availability();
  end if;
end;
$fn$;
revoke all on function public.set_priority_allocation(boolean) from public;
grant execute on function public.set_priority_allocation(boolean) to authenticated, service_role;

-- ── 6. Order-time enforcement ─────────────────────────────────────────────
-- The authoritative allocated quantity, not just raw stock, bounds what a
-- new order line may take. Runs before the line's own stock deduction (the
-- line is inserted first in place_order()), so it sees availability as it
-- was before this line; the row lock serializes two orders racing for the
-- last portions. A variant without its own recipe uses the item's base row.
create or replace function app.guard_order_line_availability() returns trigger
language plpgsql security definer set search_path = public, app as $fn$
declare v_status text; v_qty numeric; v_found boolean := false; v_name text;
begin
  if new.menu_item_id is null then
    return new;
  end if;
  if new.variant_id is not null then
    select status, producible_qty into v_status, v_qty from public.product_availability
     where menu_item_id = new.menu_item_id and variant_id = new.variant_id
     for update;
    v_found := found;
  end if;
  if not v_found then
    select status, producible_qty into v_status, v_qty from public.product_availability
     where menu_item_id = new.menu_item_id and variant_id is null
     for update;
    v_found := found;
  end if;
  if v_found and (v_status = 'unavailable' or (v_qty is not null and v_qty < new.qty)) then
    v_name := coalesce(new.name_snapshot, new.menu_item_id::text);
    raise exception 'item_unavailable: % (% available)', v_name, coalesce(floor(v_qty)::int, 0)
      using errcode = 'check_violation';
  end if;
  return new;
end;
$fn$;
drop trigger if exists guard_order_line_availability on public.order_lines;
create trigger guard_order_line_availability before insert on public.order_lines
  for each row execute function app.guard_order_line_availability();

-- ── 7. Kitchen actions through the same chain ─────────────────────────────
-- Waste N portions of a dish: deducts its recipe's ingredients (variant
-- recipe if it has one, else the base recipe — same rule as place_order()),
-- which fires the stock trigger and recalculates availability. Never drives
-- stock below zero.
create or replace function public.record_dish_waste(
  p_menu_item_id uuid, p_variant_id uuid, p_qty int, p_reason text
) returns void language plpgsql security definer set search_path = public, app as $fn$
declare v_has_variant_recipe boolean; v_comp record; v_need numeric; v_cost numeric; v_name text;
begin
  if not app.has_perm('kitchen.record_waste') then
    raise exception 'forbidden' using errcode = 'insufficient_privilege';
  end if;
  if coalesce(p_qty, 0) <= 0 then raise exception 'bad_qty' using errcode = 'check_violation'; end if;
  if coalesce(trim(p_reason), '') = '' then raise exception 'reason_required' using errcode = 'check_violation'; end if;
  select name into v_name from public.menu_items where id = p_menu_item_id;
  if not found then raise exception 'item_not_found' using errcode = 'no_data_found'; end if;
  select exists(select 1 from public.recipe_components
                 where menu_item_id = p_menu_item_id and variant_id = p_variant_id)
    into v_has_variant_recipe;
  for v_comp in
    select inventory_item_id, qty_per_unit from public.recipe_components
     where menu_item_id = p_menu_item_id
       and variant_id is not distinct from (case when v_has_variant_recipe then p_variant_id else null end)
  loop
    v_need := v_comp.qty_per_unit * p_qty;
    select cost_cents_per_base_unit into v_cost from public.inventory_items where id = v_comp.inventory_item_id;
    update public.inventory_items set stock_qty = greatest(stock_qty - v_need, 0)
     where id = v_comp.inventory_item_id;
    insert into public.stock_ledger (inventory_item_id, delta_qty, reason, note, unit_cost_cents_base)
    values (v_comp.inventory_item_id, -v_need, 'spoilage',
            v_name || ' ×' || p_qty || ': ' || trim(p_reason), v_cost);
  end loop;
  perform app.log_action('kitchen.dish_waste', 'menu_items', p_menu_item_id::text, null,
                         jsonb_build_object('variant_id', p_variant_id, 'qty', p_qty, 'reason', p_reason));
end;
$fn$;
revoke all on function public.record_dish_waste(uuid, uuid, int, text) from public;
grant execute on function public.record_dish_waste(uuid, uuid, int, text) to authenticated, service_role;

-- Manual take-off-sale switch for an item (set_variant_available covers
-- variants). A kill switch only — it never sets a quantity; the computed
-- availability keeps updating underneath and both combine at read time.
create or replace function public.set_item_available(p_menu_item_id uuid, p_available boolean)
returns void language plpgsql security definer set search_path = public, app as $fn$
begin
  if not (app.has_perm('kitchen.manage_availability') or app.has_perm('availability.update')
          or app.has_perm('menu.update')) then
    raise exception 'forbidden' using errcode = 'insufficient_privilege';
  end if;
  update public.menu_items set is_available = p_available where id = p_menu_item_id;
  if not found then raise exception 'item_not_found' using errcode = 'no_data_found'; end if;
  perform app.log_action('kitchen.item_availability', 'menu_items', p_menu_item_id::text, null,
                         jsonb_build_object('is_available', p_available));
end;
$fn$;
revoke all on function public.set_item_available(uuid, boolean) from public;
grant execute on function public.set_item_available(uuid, boolean) to authenticated, service_role;

-- Kitchen needs the names that go with the availability rows.
drop policy if exists kitchen_read_items on public.menu_items;
create policy kitchen_read_items on public.menu_items for select using (app.has_perm('kitchen.view'));
drop policy if exists kitchen_read_variants on public.menu_variants;
create policy kitchen_read_variants on public.menu_variants for select using (app.has_perm('kitchen.view'));
drop policy if exists kitchen_read_availability on public.product_availability;
create policy kitchen_read_availability on public.product_availability for select using (app.has_perm('kitchen.view'));

-- ════════════════════════════════════════════════════════════════════════════
-- 0061_priority_allocation_getter (verbatim from tenant-migrations)
-- ════════════════════════════════════════════════════════════════════════════
-- ============================================================================
-- Tenant delta 0061 — read the Priority Allocation switch without
-- settings.view.
--
-- The Priority Allocation page (availability.view) shows whether allocation
-- is ON; business_settings itself is only readable with settings.view, and
-- widening that policy would expose every business setting. This returns
-- just the one flag.
-- ============================================================================

create or replace function public.get_priority_allocation_enabled()
returns boolean language plpgsql stable security definer set search_path = public, app as $fn$
begin
  if not (app.has_perm('availability.view') or app.has_perm('availability.update') or app.is_staff()) then
    raise exception 'forbidden' using errcode = 'insufficient_privilege';
  end if;
  return app.priority_allocation_on();
end;
$fn$;
revoke all on function public.get_priority_allocation_enabled() from public;
grant execute on function public.get_priority_allocation_enabled() to authenticated, service_role;

-- ════════════════════════════════════════════════════════════════════════════
-- 0062_priority_level_percentages (verbatim from tenant-migrations)
-- ════════════════════════════════════════════════════════════════════════════
-- ============================================================================
-- Tenant delta 0062 — Priority-level percentage allocation.
--
-- Replaces the pure "higher priority takes everything first" waterfall of
-- 0054/0060 with a percentage split between the four existing priority
-- levels (product_priority.priority_level). Nothing new is modelled per
-- product: products keep their level and rank; the restaurant configures one
-- percentage (and an active flag) per level, validated to total exactly 100.
--
-- Calculation order (per connected group of products sharing ingredients —
-- the same scoped closure 0060 introduced):
--   1. Usable stock = live inventory_items.stock_qty (never below zero).
--   2. Each shared ingredient's capacity is split between the ACTIVE levels
--      that have at least one product needing it, in proportion to their
--      percentages (a level with no product on that ingredient doesn't hold
--      a share of it — its percentage goes to the others).
--   3. Within a level, products take from that level's share in rank order,
--      each limited by its full recipe (every ingredient), so no product is
--      ever allocated beyond what its recipe can actually produce.
--   4. Redistribution: whatever a level couldn't use (a product bottlenecked
--      on another ingredient, or nothing left to make) is split again, by the
--      same percentages, among the levels whose products can still make more.
--      Repeats until nothing more moves (bounded).
--   5. Final pass: any remainder the percentages couldn't place (rounding to
--      whole portions, 0% or inactive levels, unprioritized products) goes
--      by priority order — critical first, unprioritized last — so capacity
--      is never lost.
--   6. Each product's total is capped by its independent recipe capacity and
--      written through the same app.apply_product_availability_result() into
--      product_availability — the one table every surface reads.
--
-- Percentages allocate PRODUCTION CAPACITY only: no stock is reserved, moved
-- or consumed here. priority_stock_pool is the same scratch pool 0054 uses,
-- reseeded from live stock on every run. Orders still consume inventory
-- through place_order(), and 0060's order-line check still enforces the
-- allocated quantity.
-- ============================================================================

create table if not exists public.priority_level_allocation (
  priority_level text primary key check (priority_level in ('critical', 'high', 'medium', 'low')),
  allocation_pct numeric(5,2) not null check (allocation_pct >= 0 and allocation_pct <= 100),
  is_active      boolean not null default true,
  updated_at     timestamptz not null default now()
);
insert into public.priority_level_allocation (priority_level, allocation_pct, is_active) values
  ('critical', 40, true), ('high', 30, true), ('medium', 20, true), ('low', 10, true)
on conflict (priority_level) do nothing;
alter table public.priority_level_allocation enable row level security;
drop policy if exists staff_read on public.priority_level_allocation;
create policy staff_read on public.priority_level_allocation for select
  using (app.has_perm('availability.view') or app.has_perm('availability.update') or app.is_staff());
-- No write policy: changes only through set_priority_level_allocation().
drop trigger if exists audit on public.priority_level_allocation;
create trigger audit after insert or update or delete on public.priority_level_allocation
  for each row execute function app.audit_row();
do $$
begin
  if not exists (select 1 from pg_publication_tables
                  where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'priority_level_allocation') then
    alter publication supabase_realtime add table public.priority_level_allocation;
  end if;
end $$;

-- Save all four levels at once. Server-side validation: exactly the four
-- levels, each a number 0–100, total exactly 100. availability.update is
-- the same key that already governs priorities.
create or replace function public.set_priority_level_allocation(p_config jsonb)
returns void language plpgsql security definer set search_path = public, app as $fn$
declare v_total numeric := 0; v_e jsonb; v_levels text[] := '{}'; v_pct numeric;
begin
  if not (app.has_perm('availability.update') or app.can_write()) then
    raise exception 'forbidden' using errcode = 'insufficient_privilege';
  end if;
  if jsonb_typeof(p_config) is distinct from 'array' or jsonb_array_length(p_config) <> 4 then
    raise exception 'bad_config: provide all four priority levels' using errcode = 'check_violation';
  end if;
  for v_e in select * from jsonb_array_elements(p_config) loop
    if coalesce(v_e->>'priority_level', '') not in ('critical', 'high', 'medium', 'low')
       or (v_e->>'priority_level') = any(v_levels) then
      raise exception 'bad_config: each of critical, high, medium, low exactly once' using errcode = 'check_violation';
    end if;
    if coalesce(v_e->>'allocation_pct', '') !~ '^\d{1,3}(\.\d{1,2})?$' then
      raise exception 'bad_percentage: % must be a number from 0 to 100', v_e->>'priority_level' using errcode = 'check_violation';
    end if;
    v_pct := (v_e->>'allocation_pct')::numeric;
    if v_pct < 0 or v_pct > 100 then
      raise exception 'bad_percentage: % must be a number from 0 to 100', v_e->>'priority_level' using errcode = 'check_violation';
    end if;
    v_levels := v_levels || (v_e->>'priority_level');
    v_total := v_total + v_pct;
  end loop;
  if v_total <> 100 then
    raise exception 'bad_total: percentages add up to % percent, they must total exactly 100 percent', v_total
      using errcode = 'check_violation';
  end if;

  update public.priority_level_allocation pla
     set allocation_pct = (e->>'allocation_pct')::numeric,
         is_active = coalesce((e->>'is_active')::boolean, true),
         updated_at = now()
    from jsonb_array_elements(p_config) e
   where pla.priority_level = e->>'priority_level';

  perform app.log_action('availability.level_allocation', 'priority_level_allocation', null, null, p_config);
  perform app.recalc_priority_allocation('priority_change', 'level_percentages', null);
end;
$fn$;
revoke all on function public.set_priority_level_allocation(jsonb) from public;
grant execute on function public.set_priority_level_allocation(jsonb) to authenticated, service_role;

-- ── The allocation run ────────────────────────────────────────────────────
create or replace function app.recalc_priority_allocation(
  p_trigger_type text default 'priority_reallocation',
  p_trigger_reference text default null,
  p_ingredient_ids uuid[] default null
) returns void language plpgsql security definer set search_path = public, app as $fn$
declare
  v_scope uuid[];
  v_pass int;
  v_moved numeric;
  v_p record;
  v_r record;
  v_live record;
  v_cap numeric;
  v_claim numeric;
  v_extra numeric;
  v_final numeric;
  v_status text;
  v_reason text;
begin
  if not app.priority_allocation_on() then
    return;
  end if;
  perform pg_advisory_xact_lock(hashtext('app.recalc_priority_allocation'));

  if p_ingredient_ids is null then
    select coalesce(array_agg(id), '{}'::uuid[]) into v_scope from public.inventory_items;
  else
    v_scope := app.availability_scope(p_ingredient_ids);
  end if;
  if cardinality(v_scope) = 0 then
    return;
  end if;

  -- 1. Usable stock.
  delete from public.priority_stock_pool where inventory_item_id = any(v_scope);
  insert into public.priority_stock_pool (inventory_item_id, remaining)
    select id, greatest(stock_qty, 0) from public.inventory_items where id = any(v_scope);

  -- Products in scope with their level, rank and effective percentage.
  create temp table if not exists alloc_product (
    menu_item_id uuid, variant_id uuid, level text, level_rank int, rank_in_level int,
    item_name text, pct numeric not null default 0, claim numeric not null default 0
  ) on commit drop;
  create temp table if not exists alloc_level_pool (
    level text, inventory_item_id uuid, remaining numeric, primary key (level, inventory_item_id)
  ) on commit drop;
  truncate alloc_product;

  insert into alloc_product (menu_item_id, variant_id, level, level_rank, rank_in_level, item_name, pct)
  select x.menu_item_id, x.variant_id, pp.priority_level,
         case pp.priority_level when 'critical' then 0 when 'high' then 1 when 'medium' then 2 when 'low' then 3 else 4 end,
         coalesce(pp.priority_rank, 999999), mi.name,
         coalesce(case when pla.is_active then pla.allocation_pct end, 0)
    from (select distinct menu_item_id, variant_id from public.recipe_components
           where inventory_item_id = any(v_scope)) x
    join public.menu_items mi on mi.id = x.menu_item_id
    left join public.product_priority pp on pp.menu_item_id = x.menu_item_id
    left join public.priority_level_allocation pla on pla.priority_level = pp.priority_level;

  -- 2–4. Percentage rounds, then redistribution rounds of what's left.
  for v_pass in 1..8 loop
    truncate alloc_level_pool;
    insert into alloc_level_pool (level, inventory_item_id, remaining)
    with hungry as (
      -- products with a percentage that can still make at least one more
      select ap.level, ap.pct, ap.menu_item_id, ap.variant_id
        from alloc_product ap
       where ap.pct > 0
         and (select min(floor(ps.remaining / rc.qty_per_unit))
                from public.recipe_components rc
                join public.priority_stock_pool ps on ps.inventory_item_id = rc.inventory_item_id
               where rc.menu_item_id = ap.menu_item_id
                 and rc.variant_id is not distinct from ap.variant_id) > 0
    ),
    level_ing as (
      select distinct h.level, h.pct, rc.inventory_item_id
        from hungry h
        join public.recipe_components rc
          on rc.menu_item_id = h.menu_item_id and rc.variant_id is not distinct from h.variant_id
    ),
    totals as (
      select inventory_item_id, sum(pct) as total from level_ing group by inventory_item_id
    )
    select li.level, li.inventory_item_id, ps.remaining * li.pct / t.total
      from level_ing li
      join totals t on t.inventory_item_id = li.inventory_item_id
      join public.priority_stock_pool ps on ps.inventory_item_id = li.inventory_item_id
     where t.total > 0;

    v_moved := 0;
    for v_p in
      select * from alloc_product where pct > 0
       order by level_rank, rank_in_level, item_name, variant_id nulls first
    loop
      -- whole portions this product can make from its level's share of
      -- EVERY ingredient in its recipe (a missing share counts as none)
      select min(floor(coalesce(lp.remaining, 0) / rc.qty_per_unit)) into v_cap
        from public.recipe_components rc
        left join alloc_level_pool lp on lp.level = v_p.level and lp.inventory_item_id = rc.inventory_item_id
       where rc.menu_item_id = v_p.menu_item_id and rc.variant_id is not distinct from v_p.variant_id;
      v_cap := greatest(coalesce(v_cap, 0), 0);
      if v_cap > 0 then
        update alloc_level_pool lp set remaining = lp.remaining - v_cap * rc.qty_per_unit
          from public.recipe_components rc
         where rc.menu_item_id = v_p.menu_item_id and rc.variant_id is not distinct from v_p.variant_id
           and lp.level = v_p.level and lp.inventory_item_id = rc.inventory_item_id;
        update public.priority_stock_pool ps set remaining = ps.remaining - v_cap * rc.qty_per_unit
          from public.recipe_components rc
         where rc.menu_item_id = v_p.menu_item_id and rc.variant_id is not distinct from v_p.variant_id
           and ps.inventory_item_id = rc.inventory_item_id;
        update alloc_product set claim = claim + v_cap
         where menu_item_id = v_p.menu_item_id and variant_id is not distinct from v_p.variant_id;
        v_moved := v_moved + v_cap;
      end if;
    end loop;
    exit when v_moved = 0;
  end loop;

  -- 5–6. Final priority pass over every product in scope (including 0% /
  -- inactive levels, unprioritized products and modifier-only items), then
  -- write the authoritative result.
  for v_p in
    select ap.menu_item_id, ap.variant_id, ap.level_rank, ap.rank_in_level, ap.item_name, ap.claim, true as has_recipe
      from alloc_product ap
    union all
    select mg.menu_item_id, null::uuid,
           case pp.priority_level when 'critical' then 0 when 'high' then 1 when 'medium' then 2 when 'low' then 3 else 4 end,
           coalesce(pp.priority_rank, 999999), mi.name, 0, false
      from public.modifier_groups mg
      join public.menu_items mi on mi.id = mg.menu_item_id
      left join public.product_priority pp on pp.menu_item_id = mg.menu_item_id
     where mg.min_select >= 1
       and not exists (select 1 from alloc_product ap where ap.menu_item_id = mg.menu_item_id)
       and (p_ingredient_ids is null or exists (
             select 1 from public.modifier_options mo
               join public.modifier_recipe_components mrc on mrc.modifier_option_id = mo.id
              where mo.group_id = mg.id and mrc.inventory_item_id = any(v_scope)))
     group by mg.menu_item_id, pp.priority_level, pp.priority_rank, mi.name
     order by 3, 4, 5, 2 nulls first
  loop
    -- independent recipe capacity from live stock: the ceiling, plus the
    -- status/bottleneck/required-modifier checks
    select * into v_live from app.compute_product_capacity(v_p.menu_item_id, v_p.variant_id, false);

    if not v_p.has_recipe then
      perform app.apply_product_availability_result(
        v_p.menu_item_id, v_p.variant_id, v_live.tracked, v_live.status, v_live.producible_qty,
        v_live.bottleneck_inventory_item_id, v_live.reason, p_trigger_type, p_trigger_reference, 'system');
      continue;
    end if;

    select * into v_r from app.compute_product_capacity(v_p.menu_item_id, v_p.variant_id, true);
    v_extra := greatest(coalesce(v_r.producible_qty, 0), 0);
    if v_extra > 0 then
      update public.priority_stock_pool ps set remaining = ps.remaining - v_extra * rc.qty_per_unit
        from public.recipe_components rc
       where rc.menu_item_id = v_p.menu_item_id and rc.variant_id is not distinct from v_p.variant_id
         and ps.inventory_item_id = rc.inventory_item_id;
    end if;

    v_claim := coalesce(v_p.claim, 0);
    v_final := least(v_claim + v_extra, greatest(coalesce(v_live.producible_qty, 0), 0));

    if v_live.status = 'unavailable' then
      v_final := 0;
      v_status := 'unavailable';
      v_reason := v_live.reason;
    elsif v_final <= 0 then
      v_final := 0;
      v_status := 'unavailable';
      v_reason := 'Allocated to higher-priority items';
    else
      v_status := case when v_live.status = 'low_stock' then 'low_stock' else 'available' end;
      v_reason := case when v_live.status = 'low_stock' then v_live.reason end;
    end if;

    perform app.apply_product_availability_result(
      v_p.menu_item_id, v_p.variant_id, true, v_status, v_final,
      v_live.bottleneck_inventory_item_id, v_reason, p_trigger_type, p_trigger_reference, 'system');
  end loop;
end;
$fn$;

-- ════════════════════════════════════════════════════════════════════════════
-- 0063_permission_helpers_never_null (verbatim from tenant-migrations)
-- ════════════════════════════════════════════════════════════════════════════
-- ============================================================================
-- Tenant delta 0063 — permission helpers must never return NULL.
--
-- SECURITY FIX. app.can_write() was
--     select app.current_member_role() in ('owner', 'manager')
-- which is NULL — not false — for any JWT without a member role, i.e. every
-- custom-portal login. Many SECURITY DEFINER functions guard themselves with
--     if not (app.has_perm('x') or app.can_write()) then raise 'forbidden'
-- and for a portal lacking 'x' that is  not (false or NULL)  =  NULL,  which
-- an IF treats as "don't raise": the check was silently skipped. Examples:
-- approve_purchase_order, record_supplier_payment, receive_purchase_order,
-- submit_stock_count, record_ingredient_waste, set_product_priority,
-- set_priority_allocation, supplier_statement.
--
-- Row-level security was NOT affected (a NULL policy result already denies),
-- and guards that don't OR in can_write() were not affected. Owner/manager
-- (true) and every other role (false) behave exactly as before; only the
-- NULL case changes, to false. has_perm() gets the same treatment so a
-- request with no role claim at all can't produce NULL either.
-- ============================================================================

create or replace function app.can_write()
returns boolean language sql stable as $$
  select coalesce(app.current_member_role() in ('owner', 'manager'), false)
$$;

create or replace function app.has_perm(p_perm text)
returns boolean language sql stable as $$
  select coalesce(
    app.jwt_role() = 'service_role'
    or '*' = any(app.jwt_permissions())
    or p_perm = any(app.jwt_permissions())
    -- transitional: an owner/manager with no explicit permissions still writes.
    or (app.jwt_permissions() = '{}'::text[] and app.can_write()),
    false)
$$;

-- ════════════════════════════════════════════════════════════════════════════
-- 0064_deals_workspace (verbatim from tenant-migrations)
-- ════════════════════════════════════════════════════════════════════════════
-- ============================================================================
-- Tenant delta 0064 — Deals & Combos workspace.
--
-- Extends the existing deals model (deals / deal_components /
-- deal_option_groups / deal_option_items, place_order()'s header +
-- component lines, deal_profitability()) with what the redesigned Deals &
-- Combos screens need. No second deal model.
--
--   * deals gains: type, lifecycle status (draft/active/paused — "scheduled"
--     and "expired" are derived from starts_at/ends_at), a DEAL-00001
--     reference, customer display (tagline, badge, show savings), schedule
--     (days of week + daily time window), rules (min/max per order, total
--     usage limit) and channels (order types + sales channels).
--   * status and the existing is_available flag stay in sync both ways, so
--     every existing reader (storefront, place_order, AI) keeps working.
--   * The new rules are enforced server-side when an order is placed
--     (BEFORE INSERT on the deal's header order line) — never only in UI.
--   * Read-only RPCs for the screens: deal_performance (usage/revenue per
--     deal + daily series), deal_availability (how many of each deal can
--     be made right now, from the authoritative product_availability and
--     the bottleneck item), deal_cost_estimate (food cost of a draft combo),
--     live_deal_ids (deals sellable right now on a given channel).
--   * Deal images can be uploaded by deals.create/deals.update holders
--     into the existing public menu-images bucket, under deals/.
-- ============================================================================

-- ── Columns ───────────────────────────────────────────────────────────────
alter table public.deals add column if not exists deal_type text not null default 'combo';
alter table public.deals add column if not exists status text not null default 'active';
alter table public.deals add column if not exists ref_code text;
alter table public.deals add column if not exists tagline text;
alter table public.deals add column if not exists badge text;
alter table public.deals add column if not exists show_savings boolean not null default true;
alter table public.deals add column if not exists active_days int[];
alter table public.deals add column if not exists start_time time;
alter table public.deals add column if not exists end_time time;
alter table public.deals add column if not exists min_qty int not null default 1;
alter table public.deals add column if not exists max_qty int;
alter table public.deals add column if not exists usage_limit int;
alter table public.deals add column if not exists order_types text[] not null default array['dine_in', 'takeaway', 'delivery'];
alter table public.deals add column if not exists sales_channels text[] not null default array['customer_portal', 'pos'];
alter table public.deals add column if not exists updated_at timestamptz not null default now();

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'deals_deal_type_check') then
    alter table public.deals add constraint deals_deal_type_check
      check (deal_type in ('combo', 'meal_deal', 'bucket', 'discount'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'deals_status_check') then
    alter table public.deals add constraint deals_status_check check (status in ('draft', 'active', 'paused'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'deals_rules_check') then
    alter table public.deals add constraint deals_rules_check check (
      min_qty >= 1 and (max_qty is null or max_qty >= min_qty) and (usage_limit is null or usage_limit >= 1)
      and (active_days is null or active_days <@ array[0, 1, 2, 3, 4, 5, 6])
      and order_types <@ array['dine_in', 'takeaway', 'delivery']
      and sales_channels <@ array['customer_portal', 'pos']);
  end if;
end $$;

create sequence if not exists public.deal_ref_seq;
update public.deals set status = case when is_available then 'active' else 'paused' end
 where ref_code is null;
update public.deals set ref_code = 'DEAL-' || lpad(nextval('public.deal_ref_seq')::text, 5, '0')
 where ref_code is null;
create unique index if not exists deals_ref_code_uq on public.deals(ref_code);

-- status ↔ is_available stay in sync; every new deal gets a reference.
create or replace function app.deals_before_write() returns trigger
language plpgsql as $$
begin
  if new.ref_code is null then
    new.ref_code := 'DEAL-' || lpad(nextval('public.deal_ref_seq')::text, 5, '0');
  end if;
  if tg_op = 'INSERT' then
    -- An older caller that only sets is_available = false means "paused".
    if new.status = 'active' and not new.is_available then
      new.status := 'paused';
    end if;
    new.is_available := new.status = 'active';
  elsif new.status is distinct from old.status then
    new.is_available := new.status = 'active';
  elsif new.is_available is distinct from old.is_available then
    new.status := case when new.is_available then 'active' else 'paused' end;
  end if;
  new.updated_at := now();
  return new;
end $$;
drop trigger if exists deals_before_write on public.deals;
create trigger deals_before_write before insert or update on public.deals
  for each row execute function app.deals_before_write();

-- ── Is a deal sellable right now on this sales channel? ────────────────────
create or replace function app.deal_is_live(p_deal public.deals, p_sales_channel text)
returns boolean language sql stable security definer set search_path = public, app as $$
  with tz as (
    select now() at time zone coalesce((select timezone from public.business_settings where id), 'UTC') as local_now
  )
  select p_deal.status = 'active'
     and (p_deal.starts_at is null or p_deal.starts_at <= now())
     and (p_deal.ends_at is null or p_deal.ends_at >= now())
     and (p_sales_channel is null or p_sales_channel = any(p_deal.sales_channels))
     and (p_deal.active_days is null or cardinality(p_deal.active_days) = 0
          or extract(dow from (select local_now from tz))::int = any(p_deal.active_days))
     and (p_deal.start_time is null or p_deal.end_time is null
          or case when p_deal.start_time <= p_deal.end_time
               then (select local_now from tz)::time between p_deal.start_time and p_deal.end_time
               else (select local_now from tz)::time >= p_deal.start_time
                 or (select local_now from tz)::time <= p_deal.end_time  -- window crosses midnight
             end)
$$;

-- For the storefront / menu API (anon): which deals can be ordered now.
create or replace function public.live_deal_ids(p_sales_channel text default 'customer_portal')
returns uuid[] language sql stable security definer set search_path = public, app as $$
  select coalesce(array_agg(d.id), '{}'::uuid[]) from public.deals d where app.deal_is_live(d, p_sales_channel)
$$;
revoke all on function public.live_deal_ids(text) from public;
grant execute on function public.live_deal_ids(text) to anon, authenticated, service_role;

-- ── Order-time enforcement (the deal's HEADER line: deal_id set, no item) ──
create or replace function app.guard_deal_order_line() returns trigger
language plpgsql security definer set search_path = public, app as $fn$
declare
  v_deal public.deals;
  v_order record;
  v_source text;
  v_in_order int;
  v_used int;
begin
  if new.deal_id is null or new.menu_item_id is not null then
    return new;
  end if;
  -- Row lock serializes two orders racing for the last uses of a limit.
  select * into v_deal from public.deals where id = new.deal_id for update;
  if not found then return new; end if;
  select channel::text as channel, session_id into v_order from public.orders where id = new.order_id;
  v_source := case when v_order.session_id is not null then 'customer_portal' else 'pos' end;

  if not app.deal_is_live(v_deal, v_source) then
    raise exception 'deal_unavailable: % is not available right now', v_deal.name using errcode = 'check_violation';
  end if;
  if v_order.channel is not null and not (v_order.channel = any(v_deal.order_types)) then
    raise exception 'deal_unavailable: % is not offered for %', v_deal.name, replace(v_order.channel, '_', ' ')
      using errcode = 'check_violation';
  end if;

  select coalesce(sum(qty), 0) into v_in_order from public.order_lines
   where order_id = new.order_id and deal_id = new.deal_id and menu_item_id is null;
  if new.qty + v_in_order < v_deal.min_qty then
    raise exception 'deal_rule: order at least % × %', v_deal.min_qty, v_deal.name using errcode = 'check_violation';
  end if;
  if v_deal.max_qty is not null and new.qty + v_in_order > v_deal.max_qty then
    raise exception 'deal_rule: at most % × % per order', v_deal.max_qty, v_deal.name using errcode = 'check_violation';
  end if;
  if v_deal.usage_limit is not null then
    select coalesce(sum(l.qty), 0) into v_used
      from public.order_lines l join public.orders o on o.id = l.order_id
     where l.deal_id = new.deal_id and l.menu_item_id is null and o.status <> 'void';
    if v_used + new.qty > v_deal.usage_limit then
      raise exception 'deal_rule: % has reached its limit of % orders', v_deal.name, v_deal.usage_limit
        using errcode = 'check_violation';
    end if;
  end if;
  return new;
end $fn$;
drop trigger if exists guard_deal_order_line on public.order_lines;
create trigger guard_deal_order_line before insert on public.order_lines
  for each row execute function app.guard_deal_order_line();

-- ── Screens: performance, availability, cost estimate ─────────────────────
create or replace function public.deal_performance(p_from timestamptz, p_to timestamptz)
returns table (deal_id uuid, orders bigint, qty bigint, revenue_cents bigint)
language plpgsql stable security definer set search_path = public, app as $fn$
begin
  if not (app.has_perm('deals.view') or app.is_staff()) then
    raise exception 'forbidden' using errcode = 'insufficient_privilege';
  end if;
  return query
    select l.deal_id, count(distinct l.order_id), coalesce(sum(l.qty), 0)::bigint,
           coalesce(sum(l.line_total_cents), 0)::bigint
      from public.order_lines l join public.orders o on o.id = l.order_id
     where l.deal_id is not null and l.menu_item_id is null and o.status <> 'void'
       and o.created_at >= p_from and o.created_at < p_to
     group by l.deal_id;
end $fn$;
revoke all on function public.deal_performance(timestamptz, timestamptz) from public;
grant execute on function public.deal_performance(timestamptz, timestamptz) to authenticated, service_role;

create or replace function public.deal_performance_daily(p_from timestamptz, p_to timestamptz)
returns table (day date, orders bigint, revenue_cents bigint)
language plpgsql stable security definer set search_path = public, app as $fn$
declare v_tz text := coalesce((select timezone from public.business_settings where id), 'UTC');
begin
  if not (app.has_perm('deals.view') or app.is_staff()) then
    raise exception 'forbidden' using errcode = 'insufficient_privilege';
  end if;
  return query
    select g.d::date,
           coalesce(count(distinct l.order_id) filter (where l.order_id is not null), 0)::bigint,
           coalesce(sum(l.line_total_cents), 0)::bigint
      from generate_series((p_from at time zone v_tz)::date, (p_to at time zone v_tz)::date, interval '1 day') g(d)
      left join public.orders o
        on (o.created_at at time zone v_tz)::date = g.d::date and o.status <> 'void'
      left join public.order_lines l
        on l.order_id = o.id and l.deal_id is not null and l.menu_item_id is null
     group by g.d
     order by g.d;
end $fn$;
revoke all on function public.deal_performance_daily(timestamptz, timestamptz) from public;
grant execute on function public.deal_performance_daily(timestamptz, timestamptz) to authenticated, service_role;

-- How many of each deal the kitchen can make now: the minimum over its fixed
-- components of floor(component availability / qty per deal), from the
-- same product_availability rows every other surface reads (a variant
-- without its own recipe uses the item's base row; an untracked component
-- doesn't limit). The legacy manual counter also caps it when enabled.
create or replace function public.deal_availability()
returns table (deal_id uuid, available_qty numeric, bottleneck_name text)
language plpgsql stable security definer set search_path = public, app as $fn$
begin
  if not (app.has_perm('deals.view') or app.has_perm('availability.view') or app.is_staff()) then
    raise exception 'forbidden' using errcode = 'insufficient_privilege';
  end if;
  return query
    with comp as (
      select dc.deal_id, dc.qty, mi.name || coalesce(' · ' || v.name, '') as label,
             coalesce(
               (select pa.producible_qty from public.product_availability pa
                 where pa.menu_item_id = dc.menu_item_id and pa.variant_id = dc.variant_id),
               (select pa.producible_qty from public.product_availability pa
                 where pa.menu_item_id = dc.menu_item_id and pa.variant_id is null)) as producible,
             coalesce(
               (select pa.status from public.product_availability pa
                 where pa.menu_item_id = dc.menu_item_id and pa.variant_id = dc.variant_id),
               (select pa.status from public.product_availability pa
                 where pa.menu_item_id = dc.menu_item_id and pa.variant_id is null)) as status
        from public.deal_components dc
        join public.menu_items mi on mi.id = dc.menu_item_id
        left join public.menu_variants v on v.id = dc.variant_id
    ),
    per as (
      select c.deal_id, c.label,
             case when c.status = 'unavailable' then 0
                  when c.producible is null then null
                  else floor(c.producible / c.qty) end as can_make
        from comp c
    ),
    ranked as (
      select p.*, row_number() over (partition by p.deal_id order by p.can_make asc nulls last) as rn
        from per p
    )
    select d.id,
           case
             when r.can_make is null and not d.track_availability then null
             when r.can_make is null then d.available_qty::numeric
             when d.track_availability then least(r.can_make, d.available_qty)
             else r.can_make
           end,
           case when r.can_make is not null then r.label end
      from public.deals d
      left join ranked r on r.deal_id = d.id and r.rn = 1;
end $fn$;
revoke all on function public.deal_availability() from public;
grant execute on function public.deal_availability() to authenticated, service_role;

-- Food cost of a (possibly unsaved) combo: [{menu_item_id, variant_id, qty}].
-- Same recipe resolution as place_order() (variant recipe replaces the
-- base one). Cost visibility keys only, like deal_profitability().
create or replace function public.deal_cost_estimate(p_components jsonb)
returns table (cost_cents int, cost_known boolean)
language plpgsql stable security definer set search_path = public, app as $fn$
declare v_e jsonb; v_item uuid; v_var uuid; v_qty int; v_has_var boolean;
        v_line numeric; v_total numeric := 0; v_known boolean := true; v_any boolean;
begin
  if not (app.has_perm('inventory.view_cost') or app.has_perm('finance.view_cogs') or app.has_perm('finance.view_profit')) then
    raise exception 'forbidden' using errcode = 'insufficient_privilege';
  end if;
  for v_e in select value from jsonb_array_elements(coalesce(p_components, '[]'::jsonb)) loop
    v_item := nullif(v_e->>'menu_item_id', '')::uuid;
    v_var := nullif(v_e->>'variant_id', '')::uuid;
    v_qty := greatest(coalesce((v_e->>'qty')::int, 1), 1);
    continue when v_item is null;
    select exists(select 1 from public.recipe_components where menu_item_id = v_item and variant_id = v_var)
      into v_has_var;
    select sum(rc.qty_per_unit * coalesce(i.cost_cents_per_base_unit, 0)), count(*) > 0
      into v_line, v_any
      from public.recipe_components rc join public.inventory_items i on i.id = rc.inventory_item_id
     where rc.menu_item_id = v_item
       and rc.variant_id is not distinct from (case when v_has_var then v_var else null end);
    if not coalesce(v_any, false) then v_known := false; end if;
    v_total := v_total + coalesce(v_line, 0) * v_qty;
  end loop;
  return query select round(v_total)::int, v_known;
end $fn$;
revoke all on function public.deal_cost_estimate(jsonb) from public;
grant execute on function public.deal_cost_estimate(jsonb) to authenticated, service_role;

-- ── Deal images ───────────────────────────────────────────────────────────
drop policy if exists "menu-images deal write" on storage.objects;
create policy "menu-images deal write" on storage.objects for all
  using (bucket_id = 'menu-images' and name like 'deals/%'
         and (app.has_perm('deals.create') or app.has_perm('deals.update')))
  with check (bucket_id = 'menu-images' and name like 'deals/%'
              and (app.has_perm('deals.create') or app.has_perm('deals.update')));

-- deals.create holders can fill in the deal they just created (insert only —
-- changing or removing contents later still needs deals.update).
drop policy if exists deals_create_components on public.deal_components;
create policy deals_create_components on public.deal_components for insert with check (app.has_perm('deals.create'));
drop policy if exists deals_create_groups on public.deal_option_groups;
create policy deals_create_groups on public.deal_option_groups for insert with check (app.has_perm('deals.create'));
drop policy if exists deals_create_group_items on public.deal_option_items;
create policy deals_create_group_items on public.deal_option_items for insert with check (app.has_perm('deals.create'));
