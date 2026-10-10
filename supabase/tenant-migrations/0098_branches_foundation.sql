-- ============================================================================
-- 0098 — Multi-branch, phase 1: the foundation.
--
-- The restaurant (this database) is the organization; its physical locations
-- are rows in public.branches. Every location-bound record gets branch_id.
--
--   • One default branch ('MAIN') is created per restaurant. Every existing
--     row belongs to it — the restaurant had exactly one location, so this is
--     the true assignment, not an arbitrary one. A row inserted without a
--     branch inherits it from its parent (payment ← order, invoice ← PO, …)
--     or falls back to the default branch (head-office costs go to it too), so every existing screen and
--     function keeps working unchanged for single-branch restaurants.
--   • Access: the owner (and any '*' login) sees every branch. A portal or
--     member login may be limited to a list of branches (empty = all).
--     RESTRICTIVE row-level policies on every branch-bound table AND that
--     limit onto the existing policies — they can only narrow access.
--   • Branches are never deleted: inactive / archived instead (history stays).
--   • More than one active branch needs the 'branches.multi' plan feature.
-- ============================================================================

-- ── 1. Branches ─────────────────────────────────────────────────────────────
create table if not exists public.branches (
  id             uuid primary key default gen_random_uuid(),
  code           text not null unique check (code ~ '^[A-Z0-9][A-Z0-9-]{1,11}$'),
  name           text not null check (length(trim(name)) between 1 and 80),
  address        text,
  city           text,
  country        text,
  timezone       text,          -- null = the restaurant's own (business_settings.timezone)
  currency_code  text check (currency_code is null or currency_code ~ '^[A-Z]{3}$'),
  opening_hours  jsonb not null default '{}'::jsonb,
  phone          text,
  settings       jsonb not null default '{}'::jsonb,
  status         text not null default 'active' check (status in ('active', 'inactive', 'archived')),
  is_default     boolean not null default false,
  status_reason  text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  created_by     uuid
);
create unique index if not exists branches_one_default on public.branches ((true)) where is_default;

insert into public.branches (code, name, is_default, status)
select 'MAIN', 'Main branch', true, 'active'
 where not exists (select 1 from public.branches where is_default);

create or replace function app.default_branch_id() returns uuid
language sql stable security definer set search_path = public as $fn$
  select id from public.branches where is_default limit 1
$fn$;

-- ── 2. Who may see which branch ─────────────────────────────────────────────
alter table public.portals     add column if not exists branch_ids uuid[] not null default '{}';
alter table public.memberships add column if not exists branch_ids uuid[] not null default '{}';

-- The branches this caller is limited to; NULL = no limit (every branch).
create or replace function app.allowed_branch_ids() returns uuid[]
language plpgsql stable security definer set search_path = public, app as $fn$
declare v uuid[];
begin
  if app.jwt_role() is distinct from 'authenticated'      -- anon / service_role: other policies govern
     or '*' = any(app.jwt_permissions())
     or app.current_member_role() = 'owner' then
    return null;
  end if;
  select coalesce(
           (select p.branch_ids from public.portals p where p.portal_user_id = app.jwt_sub() and cardinality(p.branch_ids) > 0 limit 1),
           (select m.branch_ids from public.memberships m where m.user_id = app.jwt_sub() and cardinality(m.branch_ids) > 0 limit 1))
    into v;
  return v;   -- null when nothing limits the login
end $fn$;

create or replace function app.branch_access(p_branch uuid) returns boolean
language sql stable as $fn$
  select p_branch is null or (select app.allowed_branch_ids()) is null or p_branch = any(cast((select app.allowed_branch_ids()) as uuid[]))
$fn$;

grant execute on function app.default_branch_id() to authenticated, anon, service_role;
grant execute on function app.allowed_branch_ids() to authenticated, anon, service_role;
grant execute on function app.branch_access(uuid) to authenticated, anon, service_role;

alter table public.branches enable row level security;
drop policy if exists branches_read on public.branches;
create policy branches_read on public.branches for select using (
  app.jwt_role() = 'anon' and status = 'active'           -- the guest menu shows the branch name
  or (app.is_staff() and app.branch_access(id))
);
-- No insert/update/delete policies: branches change only through the functions below.

-- ── 3. branch_id on every location-bound table ──────────────────────────────
do $mig$
declare
  t text;
  def uuid := app.default_branch_id();
  -- ledger lines may be organization-wide (supplier payments, credit notes, manual corrections)
  nullable text[] := array['financial_events'];
begin
  foreach t in array array[
    'orders', 'payments', 'table_sessions', 'restaurant_tables', 'reservations', 'stock_ledger',
    'food_stock_log', 'low_stock_events', 'purchase_orders', 'supplier_invoices', 'daily_closings',
    'expenses', 'cash_counts', 'cash_movements', 'financial_events', 'shifts', 'attendance'
  ] loop
    if to_regclass('public.' || t) is null then continue; end if;
    execute format('alter table public.%I add column if not exists branch_id uuid references public.branches(id)', t);
    if t = 'financial_events' then
      execute 'alter table public.financial_events disable trigger ledger_no_update';
    end if;
    execute format('update public.%I set branch_id = $1 where branch_id is null', t) using def;
    if t = 'financial_events' then
      execute 'alter table public.financial_events enable trigger ledger_no_update';
    end if;
    if not (t = any(nullable)) then
      execute format('alter table public.%I alter column branch_id set not null', t);
    end if;
    execute format('create index if not exists %I on public.%I (branch_id)', t || '_branch_idx', t);
  end loop;
end $mig$;

-- Per-branch uniqueness where "one per restaurant" meant "one per location".
alter table public.restaurant_tables drop constraint if exists restaurant_tables_label_key;
create unique index if not exists restaurant_tables_branch_label on public.restaurant_tables (branch_id, label);
alter table public.daily_closings drop constraint if exists daily_closings_business_date_key;
create unique index if not exists daily_closings_branch_day on public.daily_closings (branch_id, business_date);

-- ── 4. Fill branch_id on insert (parent first, then the default branch) ─────
create or replace function app.fill_branch_id() returns trigger
language plpgsql security definer set search_path = public, app as $fn$
begin
  if new.branch_id is not null then return new; end if;
  case tg_table_name
    when 'payments' then
      select o.branch_id into new.branch_id from public.orders o where o.id = new.order_id;
    when 'orders' then
      if new.session_id is not null then
        select s.branch_id into new.branch_id from public.table_sessions s where s.id = new.session_id;
      end if;
    when 'supplier_invoices' then
      if new.purchase_order_id is not null then
        select po.branch_id into new.branch_id from public.purchase_orders po where po.id = new.purchase_order_id;
      end if;
    else null;
  end case;
  if new.branch_id is null then
    new.branch_id := app.default_branch_id();
  end if;
  return new;
end $fn$;

do $mig$
declare t text;
begin
  foreach t in array array[
    'orders', 'payments', 'table_sessions', 'restaurant_tables', 'reservations', 'stock_ledger',
    'food_stock_log', 'low_stock_events', 'purchase_orders', 'supplier_invoices', 'daily_closings',
    'expenses', 'cash_counts', 'cash_movements', 'shifts', 'attendance'
  ] loop
    if to_regclass('public.' || t) is null then continue; end if;
    execute format('drop trigger if exists fill_branch_id on public.%I', t);
    execute format('create trigger fill_branch_id before insert on public.%I for each row execute function app.fill_branch_id()', t);
  end loop;
end $mig$;

-- Ledger entries take the branch of the record they came from (shared when it has none).
create or replace function app.ledger_fill_branch() returns trigger
language plpgsql security definer set search_path = public, app as $fn$
begin
  if new.branch_id is not null then return new; end if;
  if new.order_id is not null then
    select branch_id into new.branch_id from public.orders where id = new.order_id;
  end if;
  if new.branch_id is null and new.source_id is not null then
    case new.source_table
      when 'payments'         then select branch_id into new.branch_id from public.payments where id = new.source_id;
      when 'expenses'         then select branch_id into new.branch_id from public.expenses where id = new.source_id;
      when 'supplier_invoices' then select branch_id into new.branch_id from public.supplier_invoices where id = new.source_id;
      when 'purchase_orders'  then select branch_id into new.branch_id from public.purchase_orders where id = new.source_id;
      when 'cash_counts'      then select branch_id into new.branch_id from public.cash_counts where id = new.source_id;
      when 'cash_movements'   then select branch_id into new.branch_id from public.cash_movements where id = new.source_id;
      when 'daily_closings'   then select branch_id into new.branch_id from public.daily_closings where id = new.source_id;
      when 'stock_ledger'     then select branch_id into new.branch_id from public.stock_ledger where id = new.source_id;
      else null;
    end case;
  end if;
  return new;   -- supplier payments, credit notes and manual corrections stay shared unless given a branch
end $fn$;
drop trigger if exists ledger_fill_branch on public.financial_events;
create trigger ledger_fill_branch before insert on public.financial_events
  for each row execute function app.ledger_fill_branch();

-- ── 5. Branch walls (RESTRICTIVE: ANDed with the existing policies) ─────────
do $mig$
declare t text;
begin
  foreach t in array array[
    'orders', 'payments', 'table_sessions', 'restaurant_tables', 'reservations', 'stock_ledger',
    'food_stock_log', 'low_stock_events', 'purchase_orders', 'supplier_invoices', 'daily_closings',
    'expenses', 'cash_counts', 'cash_movements', 'financial_events', 'shifts', 'attendance'
  ] loop
    if to_regclass('public.' || t) is null then continue; end if;
    execute format('drop policy if exists branch_wall on public.%I', t);
    execute format(
      'create policy branch_wall on public.%I as restrictive for all using (app.branch_access(branch_id)) with check (app.branch_access(branch_id))', t);
  end loop;
end $mig$;
-- Child rows follow their order.
drop policy if exists branch_wall on public.order_lines;
create policy branch_wall on public.order_lines as restrictive for all
  using (app.branch_access((select o.branch_id from public.orders o where o.id = order_id)))
  with check (app.branch_access((select o.branch_id from public.orders o where o.id = order_id)));
drop policy if exists branch_wall on public.refunds;
create policy branch_wall on public.refunds as restrictive for all
  using (app.branch_access((select p.branch_id from public.payments p where p.id = payment_id)))
  with check (app.branch_access((select p.branch_id from public.payments p where p.id = payment_id)));

-- ── 6. Managing branches (audited) ──────────────────────────────────────────
insert into public.permission_catalog (key, grp, label, type, risk_level) values
  ('branches.view', 'Branches', 'View branches', 'read', 'normal'),
  ('branches.manage', 'Branches', 'Create, edit and deactivate branches; assign logins to branches', 'write', 'high')
on conflict (key) do update set grp = excluded.grp, label = excluded.label, type = excluded.type, risk_level = excluded.risk_level;

create or replace function app.branch_limit_ok() returns boolean
language sql stable security definer set search_path = public as $fn$
  -- Plan never synced (plan_tier null) fails open, as entitlements do elsewhere.
  select coalesce((select plan_tier is null or 'branches.multi' = any(coalesce(plan_features, '{}')) from public.business_settings where id = true), true)
      or (select count(*) from public.branches where status = 'active') < 1
$fn$;

create or replace function public.create_branch(
  p_code text, p_name text, p_address text default null, p_city text default null, p_country text default null,
  p_timezone text default null, p_currency_code text default null, p_phone text default null,
  p_opening_hours jsonb default '{}'::jsonb
) returns public.branches
language plpgsql security definer set search_path = public, app as $fn$
declare v public.branches;
begin
  if not app.has_perm('branches.manage') then raise exception 'forbidden' using errcode = 'insufficient_privilege'; end if;
  if not app.branch_limit_ok() then
    raise exception 'branch_limit: your plan includes one branch — upgrade to add more' using errcode = 'check_violation';
  end if;
  if p_timezone is not null and not exists (select 1 from pg_timezone_names where name = p_timezone) then
    raise exception 'bad_timezone' using errcode = 'check_violation';
  end if;
  insert into public.branches (code, name, address, city, country, timezone, currency_code, phone, opening_hours, created_by)
  values (upper(trim(p_code)), trim(p_name), nullif(trim(p_address), ''), nullif(trim(p_city), ''), nullif(trim(p_country), ''),
          nullif(trim(p_timezone), ''), nullif(upper(trim(p_currency_code)), ''), nullif(trim(p_phone), ''),
          coalesce(p_opening_hours, '{}'::jsonb), app.jwt_sub())
  returning * into v;
  perform app.log_action('branch.created', 'branches', v.id::text, null, to_jsonb(v));
  return v;
end $fn$;

create or replace function public.update_branch(
  p_id uuid, p_name text, p_address text default null, p_city text default null, p_country text default null,
  p_timezone text default null, p_currency_code text default null, p_phone text default null,
  p_opening_hours jsonb default null, p_settings jsonb default null
) returns public.branches
language plpgsql security definer set search_path = public, app as $fn$
declare v_old public.branches; v public.branches;
begin
  if not app.has_perm('branches.manage') or not app.branch_access(p_id) then
    raise exception 'forbidden' using errcode = 'insufficient_privilege';
  end if;
  if p_timezone is not null and p_timezone <> '' and not exists (select 1 from pg_timezone_names where name = p_timezone) then
    raise exception 'bad_timezone' using errcode = 'check_violation';
  end if;
  select * into v_old from public.branches where id = p_id for update;
  if not found then raise exception 'branch_not_found' using errcode = 'no_data_found'; end if;
  update public.branches set
      name = trim(p_name), address = nullif(trim(p_address), ''), city = nullif(trim(p_city), ''),
      country = nullif(trim(p_country), ''), timezone = nullif(trim(p_timezone), ''),
      currency_code = nullif(upper(trim(p_currency_code)), ''), phone = nullif(trim(p_phone), ''),
      opening_hours = coalesce(p_opening_hours, opening_hours), settings = coalesce(p_settings, settings),
      updated_at = now()
   where id = p_id returning * into v;
  perform app.log_action('branch.updated', 'branches', p_id::text, to_jsonb(v_old), to_jsonb(v));
  return v;
end $fn$;

create or replace function public.set_branch_status(p_id uuid, p_status text, p_reason text default null) returns public.branches
language plpgsql security definer set search_path = public, app as $fn$
declare v_old public.branches; v public.branches;
begin
  if not app.has_perm('branches.manage') or not app.branch_access(p_id) then
    raise exception 'forbidden' using errcode = 'insufficient_privilege';
  end if;
  if p_status not in ('active', 'inactive', 'archived') then raise exception 'bad_status' using errcode = 'check_violation'; end if;
  select * into v_old from public.branches where id = p_id for update;
  if not found then raise exception 'branch_not_found' using errcode = 'no_data_found'; end if;
  if p_status <> 'active' and v_old.is_default then
    raise exception 'default_branch: make another branch the default first' using errcode = 'check_violation';
  end if;
  if p_status <> 'active' and coalesce(trim(p_reason), '') = '' then
    raise exception 'reason_required' using errcode = 'check_violation';
  end if;
  if p_status = 'active' and v_old.status <> 'active' and not app.branch_limit_ok() then
    raise exception 'branch_limit: your plan includes one branch — upgrade to add more' using errcode = 'check_violation';
  end if;
  update public.branches set status = p_status, status_reason = nullif(trim(p_reason), ''), updated_at = now()
   where id = p_id returning * into v;
  perform app.log_action('branch.status_changed', 'branches', p_id::text,
    jsonb_build_object('status', v_old.status), jsonb_build_object('status', p_status, 'reason', p_reason));
  return v;
end $fn$;

create or replace function public.set_default_branch(p_id uuid) returns void
language plpgsql security definer set search_path = public, app as $fn$
begin
  if not (app.has_perm('branches.manage') and app.allowed_branch_ids() is null) then
    raise exception 'forbidden' using errcode = 'insufficient_privilege';
  end if;
  if not exists (select 1 from public.branches where id = p_id and status = 'active') then
    raise exception 'branch_not_active' using errcode = 'check_violation';
  end if;
  update public.branches set is_default = false, updated_at = now() where is_default and id <> p_id;
  update public.branches set is_default = true, updated_at = now() where id = p_id;
  perform app.log_action('branch.default_changed', 'branches', p_id::text, null, null);
end $fn$;

-- Which branches a portal / member login may use (empty = all).
create or replace function public.set_login_branches(p_kind text, p_id uuid, p_branch_ids uuid[]) returns void
language plpgsql security definer set search_path = public, app as $fn$
declare v_ids uuid[] := coalesce(p_branch_ids, '{}');
begin
  if not app.has_perm('branches.manage') then raise exception 'forbidden' using errcode = 'insufficient_privilege'; end if;
  -- A login limited to some branches may only hand out branches it has itself.
  if app.allowed_branch_ids() is not null
     and (cardinality(v_ids) = 0 or exists (select 1 from unnest(v_ids) b where not (b = any(app.allowed_branch_ids())))) then
    raise exception 'forbidden: you can only assign your own branches' using errcode = 'insufficient_privilege';
  end if;
  if exists (select 1 from unnest(v_ids) b where not exists (select 1 from public.branches where id = b)) then
    raise exception 'unknown_branch' using errcode = 'check_violation';
  end if;
  if p_kind = 'portal' then
    update public.portals set branch_ids = v_ids where id = p_id;
  elsif p_kind = 'member' then
    update public.memberships set branch_ids = v_ids where id = p_id;
  else
    raise exception 'bad_kind' using errcode = 'check_violation';
  end if;
  if not found then raise exception 'not_found' using errcode = 'no_data_found'; end if;
  perform app.log_action('branch.login_assigned', p_kind || 's', p_id::text, null, jsonb_build_object('branch_ids', v_ids));
end $fn$;

-- The branches the caller can use (for the branch selector).
create or replace function public.my_branches() returns setof public.branches
language sql stable security definer set search_path = public, app as $fn$
  select * from public.branches b
   where app.is_staff() and app.branch_access(b.id) and b.status <> 'archived'
   order by b.is_default desc, b.name
$fn$;

revoke all on function public.create_branch(text, text, text, text, text, text, text, text, jsonb) from public;
revoke all on function public.update_branch(uuid, text, text, text, text, text, text, text, jsonb, jsonb) from public;
revoke all on function public.set_branch_status(uuid, text, text) from public;
revoke all on function public.set_default_branch(uuid) from public;
revoke all on function public.set_login_branches(text, uuid, uuid[]) from public;
revoke all on function public.my_branches() from public;
grant execute on function public.create_branch(text, text, text, text, text, text, text, text, jsonb) to authenticated, service_role;
grant execute on function public.update_branch(uuid, text, text, text, text, text, text, text, jsonb, jsonb) to authenticated, service_role;
grant execute on function public.set_branch_status(uuid, text, text) to authenticated, service_role;
grant execute on function public.set_default_branch(uuid) to authenticated, service_role;
grant execute on function public.set_login_branches(text, uuid, uuid[]) to authenticated, service_role;
grant execute on function public.my_branches() to authenticated, service_role;

-- Audit every branch row change too (same trigger the other tables use).
do $$ begin
  if exists (select 1 from pg_proc where proname = 'audit_row' and pronamespace = 'app'::regnamespace) then
    drop trigger if exists audit on public.branches;
    create trigger audit after insert or update or delete on public.branches for each row execute function app.audit_row();
  end if;
end $$;
