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
