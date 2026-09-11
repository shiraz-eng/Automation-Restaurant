-- ============================================================================
-- Tenant delta 0007 — P3: roles as objects + permission presets
--
--   * public.roles — named permission presets (9 system roles seeded).
--   * memberships.extra_permissions — per-member grants on top of the role.
--   * app.compose_permissions(role, extra) — the effective permission array.
--   * public.set_member_access(...) — assign a role/extras; a caller can never
--     grant a permission they do not themselves hold (spec §37).
--   * Final statement back-fills every staff Auth user's
--     app_metadata.permissions from its role preset (idempotent, re-runnable).
--
-- Depends on 0006 (expanded permission_catalog). Idempotent throughout.
-- ============================================================================

alter table public.memberships
  add column if not exists extra_permissions text[] not null default '{}';

create table if not exists public.roles (
  id          uuid primary key default gen_random_uuid(),
  key         text not null unique,
  name        text not null,
  permissions text[] not null default '{}',
  is_system   boolean not null default false,
  created_at  timestamptz not null default now()
);

-- ── System role presets ────────────────────────────────────────────────────
-- Each staff role's preset is a superset of what that role could already do
-- under the pre-P3 is_staff()/can_write() policies, so the back-fill below
-- changes nothing that works today.
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
      'stock.update','stock.adjust','stock.history',
      'tables.create','tables.update',
      'customers.view','customers.create','customers.update',
      'supplier.view','supplier.create','supplier.update','supplier.manage',
      'purchases.view','purchases.create','purchases.update',
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

-- ── Effective-permission helpers ───────────────────────────────────────────
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

-- ── Role assignment with an anti-escalation guard ─────────────────────────
create or replace function public.set_member_access(
  p_membership_id uuid, p_role text, p_extra text[], p_actor_perms text[]
) returns text[]
language plpgsql security definer set search_path = public, app as $$
declare
  v_effective text[];
  v_key text;
  v_all boolean := coalesce(p_actor_perms, '{}'::text[]) @> array['*'];
begin
  if not v_all and not app.has_perm('permissions.assign') then
    raise exception 'forbidden' using errcode = 'insufficient_privilege';
  end if;
  if not exists (select 1 from public.roles where key = p_role) then
    raise exception 'unknown_role: %', p_role using errcode = 'foreign_key_violation';
  end if;

  v_effective := app.compose_permissions(p_role, p_extra);

  -- A caller may only assign permissions they themselves hold ('*' = anything).
  if not v_all then
    foreach v_key in array v_effective loop
      if not (coalesce(p_actor_perms, '{}'::text[]) @> array[v_key]) then
        raise exception 'cannot grant a permission you do not hold: %', v_key
          using errcode = 'insufficient_privilege';
      end if;
    end loop;
  end if;

  update public.memberships
     set role = p_role::app.member_role,
         extra_permissions = coalesce(p_extra, '{}'::text[])
   where id = p_membership_id;
  if not found then
    raise exception 'membership_not_found' using errcode = 'no_data_found';
  end if;

  return v_effective;
end $$;
revoke all on function public.set_member_access(uuid, text, text[], text[]) from public;
grant execute on function public.set_member_access(uuid, text, text[], text[]) to authenticated, service_role;

-- ── RLS + system-role protection + audit ─────────────────────────────────
alter table public.roles enable row level security;
drop policy if exists staff_read on public.roles;
drop policy if exists mgr_write on public.roles;
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
drop trigger if exists protect_system_roles on public.roles;
create trigger protect_system_roles before update or delete on public.roles
  for each row execute function app.protect_system_roles();

do $$ begin
  execute 'create trigger audit after insert or update or delete on public.roles for each row execute function app.audit_row()';
exception when duplicate_object then null; end $$;

-- NOTE: this migration only ADDS the roles machinery. Existing staff Auth users
-- keep their bare {role} JWT and behave exactly as before (the 0006 RLS OR-
-- fallback). Run 0008_backfill_staff_permissions.sql to switch them onto their
-- role preset (that is what makes non-owner enforcement fully live).
