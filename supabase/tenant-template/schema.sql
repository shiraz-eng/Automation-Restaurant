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

create or replace function app.has_perm(p_perm text)
returns boolean language sql stable as $$
  select
    -- service_role bypasses RLS entirely; this covers authenticated portals.
    coalesce(current_setting('request.jwt.claim.role', true), '') = 'service_role'
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
create table if not exists public.permission_catalog (
  key   text primary key,
  grp   text not null,
  label text not null
);
insert into public.permission_catalog (key, grp, label) values
  ('orders.view','Orders','View orders'),
  ('orders.create','Orders','Create orders'),
  ('orders.update','Orders','Update orders'),
  ('orders.cancel','Orders','Cancel orders'),
  ('payments.view','Payments','View payments'),
  ('payments.accept','Payments','Accept payment'),
  ('payments.refund','Payments','Refund payment'),
  ('kitchen.view','Kitchen','View kitchen queue'),
  ('kitchen.update_status','Kitchen','Update order/prep status'),
  ('menu.view','Menu','View menu'),
  ('menu.create','Menu','Create menu items'),
  ('menu.update','Menu','Update menu items'),
  ('menu.delete','Menu','Delete menu items'),
  ('stock.view','Stock','View food availability'),
  ('stock.update','Stock','Update food availability'),
  ('attendance.view','Attendance','View attendance'),
  ('attendance.mark','Attendance','Mark attendance'),
  ('staff.view','Staff','View staff'),
  ('staff.create','Staff','Create staff'),
  ('staff.update','Staff','Update staff'),
  ('staff.delete','Staff','Delete staff'),
  ('reviews.view','Reviews','View customer reviews'),
  ('reviews.analytics','Reviews','View review analytics'),
  ('reviews.respond','Reviews','Respond to reviews'),
  ('reviews.moderate','Reviews','Moderate reviews'),
  ('reports.view','Reports','View reports'),
  ('settings.view','Settings','View settings'),
  ('settings.update','Settings','Update settings'),
  ('portals.view','Portal Management','View portals'),
  ('portals.create','Portal Management','Create portals'),
  ('portals.update','Portal Management','Update portals'),
  ('portals.disable','Portal Management','Enable/disable portals'),
  ('portals.credentials','Portal Management','Manage portal credentials')
on conflict (key) do update set grp = excluded.grp, label = excluded.label;

-- Operations / Attendance / AI key set (P3). Kept in one place so the Portal
-- Management UI can offer every grantable permission.
insert into public.permission_catalog (key, grp, label) values
  ('orders.reopen','Orders','Reopen orders'),
  ('orders.apply_discount','Orders','Apply discount'),
  ('orders.override_price','Orders','Override item price'),
  ('payments.void','Payments','Void payment'),
  ('payments.adjust','Payments','Adjust payment'),
  ('payments.reconcile','Payments','Reconcile payments'),
  ('receipts.view','Payments','View receipts'),
  ('receipts.print','Payments','Print receipts'),
  ('variants.view','Menu','View variants'),
  ('variants.create','Menu','Create variants'),
  ('variants.update','Menu','Update variants'),
  ('variants.archive','Menu','Archive variants'),
  ('deals.view','Deals','View deals'),
  ('deals.create','Deals','Create deals'),
  ('deals.update','Deals','Update deals'),
  ('deals.archive','Deals','Archive deals'),
  ('customers.view','Customers','View customers'),
  ('customers.create','Customers','Create customers'),
  ('customers.update','Customers','Update customers'),
  ('tables.view','Tables','View tables'),
  ('tables.create','Tables','Create tables'),
  ('tables.update','Tables','Update tables'),
  ('availability.view','Availability','View food availability'),
  ('availability.update','Availability','Update food availability'),
  ('roles.view','Roles','View roles'),
  ('roles.create','Roles','Create roles'),
  ('roles.update','Roles','Update roles'),
  ('roles.delete','Roles','Delete roles'),
  ('permissions.view','Permissions','View permission assignments'),
  ('permissions.assign','Permissions','Assign permissions'),
  ('purchases.view','Purchases','View purchases'),
  ('purchases.create','Purchases','Create purchases'),
  ('purchases.update','Purchases','Update purchases'),
  ('purchases.delete','Purchases','Delete purchases'),
  ('supplier.view','Suppliers','View suppliers'),
  ('supplier.create','Suppliers','Create suppliers'),
  ('supplier.update','Suppliers','Update suppliers'),
  ('supplier.manage','Suppliers','Manage suppliers'),
  ('stock.adjust','Stock','Adjust stock'),
  ('stock.history','Stock','View stock history'),
  ('stock.count','Stock','Perform stock counts'),
  ('purchases.receive','Purchases','Receive purchase deliveries'),
  ('inventory.manage_waste','Inventory','Record ingredient waste'),
  ('inventory.manage_recipes','Inventory','Manage recipes'),
  ('inventory.view_cost','Inventory','View ingredient & recipe cost'),
  ('finance.view','Finance','View finance'),
  ('finance.create_expense','Finance','Create expense'),
  ('finance.update_expense','Finance','Update expense'),
  ('finance.delete_expense','Finance','Delete expense'),
  ('finance.view_cogs','Finance','View COGS'),
  ('finance.view_profit','Finance','View profit'),
  ('finance.manage_costs','Finance','Manage product costs'),
  ('finance.manage_recipes','Finance','Manage recipes'),
  ('finance.manage_purchases','Finance','Manage purchase costs'),
  ('finance.reconcile','Finance','Reconcile cash'),
  ('finance.close_day','Finance','Close business day'),
  ('finance.reopen_day','Finance','Reopen business day'),
  ('reports.generate','Reports','Generate reports'),
  ('reports.export','Reports','Export reports'),
  ('analytics.view','Analytics','View analytics'),
  ('analytics.export','Analytics','Export analytics'),
  ('attendance.view_dashboard','Attendance','View attendance dashboard'),
  ('attendance.view_reports','Attendance','View attendance reports'),
  ('attendance.view_employee_reports','Attendance','View employee attendance reports'),
  ('attendance.view_own','Attendance','View own attendance'),
  ('attendance.check_in','Attendance','Check in'),
  ('attendance.check_out','Attendance','Check out'),
  ('attendance.view_history','Attendance','View attendance history'),
  ('attendance.request_correction','Attendance','Request attendance correction'),
  ('attendance.correct','Attendance','Correct attendance'),
  ('attendance.approve_correction','Attendance','Approve attendance correction'),
  ('attendance.export','Attendance','Export attendance'),
  ('kitchen.manage_availability','Kitchen','Manage food availability'),
  ('kitchen.record_waste','Kitchen','Record kitchen waste'),
  ('notifications.view','Notifications','View notifications'),
  ('notifications.manage','Notifications','Manage notifications'),
  ('ai.view','AI','Use the AI assistant'),
  ('ai.execute_read','AI','AI read actions'),
  ('ai.execute_write','AI','AI write actions'),
  ('ai.approve_sensitive_action','AI','Approve sensitive AI actions')
on conflict (key) do update set grp = excluded.grp, label = excluded.label;

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
    ('manager','Manager', base || array[
      'orders.create','orders.update','orders.cancel','orders.reopen',
      'orders.apply_discount','orders.override_price',
      'payments.view','payments.accept','payments.refund','payments.void',
      'payments.adjust','payments.reconcile','receipts.view','receipts.print',
      'kitchen.update_status','kitchen.manage_availability','kitchen.record_waste',
      'menu.create','menu.update','menu.archive',
      'variants.view','variants.create','variants.update','variants.archive',
      'deals.view','deals.create','deals.update','deals.archive',
      'availability.view','availability.update',
      'stock.update','stock.adjust','stock.history','stock.count',
      'inventory.manage_waste','inventory.manage_recipes','inventory.view_cost',
      'tables.create','tables.update',
      'customers.view','customers.create','customers.update',
      'supplier.view','supplier.create','supplier.update','supplier.manage',
      'purchases.view','purchases.create','purchases.update','purchases.receive',
      'staff.view','staff.create','staff.update','staff.disable','roles.view',
      'attendance.view','attendance.mark','attendance.view_dashboard',
      'attendance.view_reports','attendance.view_employee_reports',
      'attendance.view_history','attendance.correct','attendance.approve_correction',
      'reports.view','reports.generate','reports.export',
      'analytics.view','finance.view','settings.view','portals.view',
      'notifications.manage','ai.view','ai.execute_read'
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
      'payments.view','payments.reconcile','purchases.view','supplier.view',
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
  v_all boolean := ('*' = any(v_actor))
    or coalesce(current_setting('request.jwt.claim.role', true), '') = 'service_role';
begin
  if not app.has_perm('permissions.assign') then
    raise exception 'forbidden' using errcode = 'insufficient_privilege';
  end if;
  if not exists (select 1 from public.roles where key = p_role) then
    raise exception 'unknown_role: %', p_role using errcode = 'foreign_key_violation';
  end if;

  v_effective := app.compose_permissions(p_role, p_extra);

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
create policy mgr_write on public.roles for all using (app.has_perm('roles.update') or app.can_write()) with check (app.has_perm('roles.update') or app.can_write());

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

create table public.stock_ledger (
  id uuid primary key default gen_random_uuid(),
  inventory_item_id uuid not null references public.inventory_items(id) on delete restrict,
  delta_qty numeric(14,3) not null,
  reason app.stock_reason not null,
  order_id uuid references public.orders(id) on delete set null,
  note text,
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
declare v_new numeric;
begin
  if not (app.has_perm('stock.adjust') or app.has_perm('inventory.manage')
          or (app.can_write() and app.current_member_role() is not null)) then
    raise exception 'forbidden' using errcode = 'insufficient_privilege';
  end if;
  update public.inventory_items set stock_qty = stock_qty + p_delta
   where id = p_inventory_item_id returning stock_qty into v_new;
  if not found then raise exception 'inventory_item_not_found' using errcode = 'foreign_key_violation'; end if;
  if v_new < 0 then raise exception 'would_go_negative' using errcode = 'check_violation'; end if;
  insert into public.stock_ledger (inventory_item_id, delta_qty, reason, note)
  values (p_inventory_item_id, p_delta, coalesce(nullif(p_reason,''),'adjustment')::app.stock_reason, p_note);
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
declare v_new numeric;
begin
  if not (app.has_perm('inventory.manage_waste') or app.has_perm('stock.adjust') or app.can_write()) then
    raise exception 'forbidden' using errcode = 'insufficient_privilege';
  end if;
  if coalesce(p_qty, 0) <= 0 then raise exception 'bad_qty' using errcode = 'check_violation'; end if;
  if coalesce(trim(p_note), '') = '' then raise exception 'reason_required' using errcode = 'check_violation'; end if;
  update public.inventory_items set stock_qty = stock_qty - p_qty
   where id = p_inventory_item_id and stock_qty >= p_qty
   returning stock_qty into v_new;
  if not found then raise exception 'insufficient_stock: %', p_inventory_item_id using errcode = 'check_violation'; end if;
  insert into public.stock_ledger (inventory_item_id, delta_qty, reason, note)
  values (p_inventory_item_id, -p_qty, 'spoilage', p_note);
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
declare v_before numeric; v_delta numeric;
begin
  if not (app.has_perm('stock.count') or app.has_perm('stock.adjust') or app.can_write()) then
    raise exception 'forbidden' using errcode = 'insufficient_privilege';
  end if;
  if p_counted_qty < 0 then raise exception 'bad_qty' using errcode = 'check_violation'; end if;
  select stock_qty into v_before from public.inventory_items where id = p_inventory_item_id;
  if not found then raise exception 'inventory_item_not_found' using errcode = 'foreign_key_violation'; end if;
  v_delta := p_counted_qty - v_before;
  update public.inventory_items set stock_qty = p_counted_qty where id = p_inventory_item_id;
  insert into public.stock_ledger (inventory_item_id, delta_qty, reason, note)
  values (p_inventory_item_id, v_delta, 'stock_take', coalesce(nullif(trim(p_note), ''), 'stock count'));
  return jsonb_build_object('before', v_before, 'counted', p_counted_qty, 'variance', v_delta);
end $$;
revoke all on function public.submit_stock_count(uuid, numeric, text) from public;
grant execute on function public.submit_stock_count(uuid, numeric, text) to authenticated, service_role;

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
          insert into public.stock_ledger (inventory_item_id, delta_qty, reason, order_id)
          values (v_comp.inventory_item_id, -v_need, 'order_deduction', v_order_id);
        end loop;
        update public.order_lines set recipe_cost_cents = v_recipe_cost where id = v_line_id;
      end loop;

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
        insert into public.stock_ledger (inventory_item_id, delta_qty, reason, order_id)
        values (v_comp.inventory_item_id, -v_need, 'order_deduction', v_order_id);
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
        insert into public.stock_ledger (inventory_item_id, delta_qty, reason, order_id)
        values (v_comp.inventory_item_id, -v_need, 'order_deduction', v_order_id);
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
  -- p_discount_cents is the fallback for manual till discounts).
  if coalesce(p_promo_code, '') <> '' then
    v_disc := public.promo_discount(p_promo_code, v_sub);
  end if;
  v_disc := least(greatest(v_disc, 0), v_sub);
  v_tax := round((v_sub - v_disc)::numeric * coalesce(p_tax_rate_bps,0) / 10000)::int;
  v_total := v_sub - v_disc + v_tax;
  update public.orders set subtotal_cents = v_sub, discount_cents = v_disc, promo_code = nullif(p_promo_code, ''),
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
create policy staff_read on public.payments for select using (app.has_perm('payments.view') or app.is_staff());
create policy staff_read on public.refunds for select using (app.has_perm('payments.view') or app.is_staff());
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
declare v_pay public.payments; v_ref public.refunds; v_remaining int;
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

  insert into public.refunds
    (payment_id, order_id, amount_cents, reason, method, requested_by, portal_id)
  values
    (p_payment_id, v_pay.order_id, p_amount_cents, trim(p_reason),
     coalesce(nullif(p_method, ''), v_pay.method), app.jwt_sub(), app.current_portal_id())
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

-- ── Promotions ───────────────────────────────────────────────────────────
create type app.promo_kind as enum ('percent', 'fixed');

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
  created_at        timestamptz not null default now()
);

-- discount fields on orders (place_order takes p_discount_cents)
alter table public.orders add column discount_cents int not null default 0 check (discount_cents >= 0);
alter table public.orders add column promo_code text;

-- Validate a code and return the discount for a given subtotal (0 if invalid).
create or replace function public.promo_discount(p_code text, p_subtotal_cents int)
returns int language sql stable security definer set search_path = public, app as $fn$
  select coalesce((
    select case
      when p.kind = 'percent' then (p_subtotal_cents * coalesce(p.value_bps, 0) / 10000)
      else least(coalesce(p.value_cents, 0), p_subtotal_cents)
    end
    from public.promotions p
    where lower(p.code) = lower(p_code)
      and p.active
      and p_subtotal_cents >= p.min_subtotal_cents
      and (p.starts_at is null or p.starts_at <= now())
      and (p.ends_at is null or p.ends_at >= now())
    limit 1
  ), 0);
$fn$;
grant execute on function public.promo_discount(text, int) to authenticated, service_role, anon;

alter table public.promotions enable row level security;
create policy staff_read on public.promotions for select using (app.has_perm('menu.view') or app.is_staff());
create policy mgr_write on public.promotions for all using (app.has_perm('menu.update') or app.can_write()) with check (app.has_perm('menu.update') or app.can_write());
-- anon may read active promos so the storefront can validate a code
create policy guest_read on public.promotions for select using (active);

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
  received_qty       numeric(14,3) not null default 0
);
create index po_lines_po_idx on public.purchase_order_lines(purchase_order_id);

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
      insert into public.stock_ledger (inventory_item_id, delta_qty, reason, note)
      values (r.inventory_item_id, v_recv_base, 'restock', 'PO receipt');
    end if;
    update public.purchase_order_lines set received_qty = qty where id = r.id;
  end loop;
  update public.purchase_orders set status = 'received', received_at = now() where id = p_po_id;
end $fn$;
grant execute on function public.receive_purchase_order(uuid) to authenticated, service_role;

-- Partial receiving (spec §22): receive a specific quantity against ONE
-- line, up to whatever's still outstanding — never marks the rest of the PO
-- received. Same weighted-average costing as the full receive above.
create or replace function public.receive_purchase_order_line(p_line_id uuid, p_qty numeric) returns void
language plpgsql security definer set search_path = public, app as $fn$
declare
  r record; v_factor numeric; v_old_stock numeric; v_old_cost numeric;
  v_take numeric; v_recv_base numeric; v_receipt_cost_per_base numeric; v_new_cost numeric;
  v_remaining_lines int;
begin
  if not (app.has_perm('purchases.receive') or app.has_perm('inventory.manage_purchases') or app.can_write()) then
    raise exception 'forbidden' using errcode = 'insufficient_privilege';
  end if;
  if coalesce(p_qty, 0) <= 0 then raise exception 'bad_qty' using errcode = 'check_violation'; end if;
  select id, purchase_order_id, inventory_item_id, qty, received_qty, unit_cost_cents
    into r from public.purchase_order_lines where id = p_line_id;
  if not found then raise exception 'line_not_found' using errcode = 'foreign_key_violation'; end if;
  v_take := least(p_qty, r.qty - r.received_qty);
  if v_take <= 0 then raise exception 'nothing_outstanding' using errcode = 'check_violation'; end if;

  if r.inventory_item_id is not null then
    select purchase_unit_to_base, stock_qty, cost_cents_per_base_unit
      into v_factor, v_old_stock, v_old_cost
      from public.inventory_items where id = r.inventory_item_id;
    v_recv_base := v_take * coalesce(v_factor, 1);
    v_receipt_cost_per_base := r.unit_cost_cents / greatest(coalesce(v_factor, 1), 0.0001);
    v_new_cost := case when (coalesce(v_old_stock, 0) + v_recv_base) > 0
      then (coalesce(v_old_stock, 0) * coalesce(v_old_cost, 0) + v_recv_base * v_receipt_cost_per_base)
           / (coalesce(v_old_stock, 0) + v_recv_base)
      else coalesce(v_old_cost, 0) end;
    update public.inventory_items
       set stock_qty = stock_qty + v_recv_base, cost_cents_per_base_unit = v_new_cost
     where id = r.inventory_item_id;
    insert into public.stock_ledger (inventory_item_id, delta_qty, reason, note)
    values (r.inventory_item_id, v_recv_base, 'restock', 'PO partial receipt');
  end if;
  update public.purchase_order_lines set received_qty = received_qty + v_take where id = p_line_id;

  select count(*) into v_remaining_lines from public.purchase_order_lines
   where purchase_order_id = r.purchase_order_id and received_qty < qty;
  update public.purchase_orders
     set status = case when v_remaining_lines = 0 then 'received' else 'partial' end,
         received_at = case when v_remaining_lines = 0 then now() else received_at end
   where id = r.purchase_order_id;
end $fn$;
revoke all on function public.receive_purchase_order_line(uuid, numeric) from public;
grant execute on function public.receive_purchase_order_line(uuid, numeric) to authenticated, service_role;

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
create table public.business_settings (
  id                        boolean primary key default true check (id),
  timezone                  text not null default 'UTC',
  business_day_start_minutes int not null default 0,
  currency_code             text not null default 'USD',
  week_start                int not null default 1
);
insert into public.business_settings (id) values (true);

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
create policy mgr_write  on public.business_settings for all using (app.has_perm('settings.update') or app.can_write()) with check (app.has_perm('settings.update') or app.can_write());
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
  a public.attendance; s public.shifts; cfg public.attendance_settings;
  v_worked int := 0; v_late int := 0; v_early int := 0; v_ot int := 0; v_status text;
begin
  select * into a from public.attendance where id = p_id;
  if not found then return; end if;
  select * into cfg from public.attendance_settings where id;
  select * into s from public.shifts
   where membership_id = a.membership_id and app.business_day(starts_at) = a.business_date
   order by starts_at limit 1;

  if a.clock_in is not null and a.clock_out is not null then
    v_worked := greatest(0, (extract(epoch from (a.clock_out - a.clock_in)) / 60)::int);
  end if;
  if s.id is not null then
    if a.clock_in is not null then
      v_late := greatest(0, (extract(epoch from (a.clock_in - s.starts_at)) / 60)::int - coalesce(cfg.grace_minutes, 0));
    end if;
    if a.clock_out is not null then
      v_early := greatest(0, (extract(epoch from (s.ends_at - a.clock_out)) / 60)::int);
      if coalesce(cfg.overtime_enabled, false) then
        v_ot := greatest(0, (extract(epoch from (a.clock_out - s.ends_at)) / 60)::int);
      end if;
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
               clock_in timestamptz, clock_out timestamptz, late_minutes int)
language plpgsql security definer set search_path = public, app as $fn$
begin
  if not (app.has_perm('attendance.view') or app.is_staff()) then
    raise exception 'forbidden' using errcode = 'insufficient_privilege';
  end if;
  return query
    select m.id, m.full_name, m.role::text,
           coalesce(a.status, 'not_marked'), a.clock_in, a.clock_out, coalesce(a.late_minutes, 0)
    from public.memberships m
    left join public.attendance a
      on a.membership_id = m.id and a.business_date = coalesce(p_date, app.business_day(now()))
    where m.status = 'active'
    order by m.full_name nulls last;
end $fn$;
revoke all on function public.attendance_roster(date) from public;
grant execute on function public.attendance_roster(date) to authenticated, service_role;

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
  force_pw_change boolean not null default false,
  last_login_at timestamptz,
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

-- ── Seed ─────────────────────────────────────────────────────────────────
insert into public.menu_categories (name) values ('Uncategorised');

-- The implicit Super Admin portal (the owner). No portal_user_id — the owner
-- signs in as a person; this row just anchors "everything" in Portal Management.
insert into public.portals (name, type, route_key, permissions)
values ('Super Admin', 'super_admin', 'admin', array['*']);
