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

-- ── Enums ──────────────────────────────────────────────────────────────────
create type app.member_role         as enum ('owner', 'manager', 'cashier', 'chef', 'waiter', 'host', 'hr', 'accountant', 'delivery');
create type app.member_status       as enum ('pending', 'active', 'disabled');
create type app.order_channel       as enum ('dine_in', 'takeaway', 'delivery');
create type app.order_status        as enum ('pending', 'in_kitchen', 'ready', 'served', 'paid', 'void');
create type app.line_status         as enum ('queued', 'preparing', 'ready', 'served');
create type app.stock_reason        as enum ('order_deduction', 'restock', 'adjustment', 'spoilage', 'stock_take');
create type app.reservation_status  as enum ('pending', 'confirmed', 'arrived', 'seated', 'completed', 'cancelled', 'no_show');

-- ── Staff ──────────────────────────────────────────────────────────────────
create table public.memberships (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid references auth.users(id) on delete set null,
  email      text not null unique,
  full_name  text,
  role       app.member_role not null default 'waiter',
  status     app.member_status not null default 'pending',
  created_at timestamptz not null default now()
);
create index memberships_user_id_idx on public.memberships(user_id);

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
  price_cents integer not null check (price_cents >= 0),
  is_available boolean not null default true,
  created_at timestamptz not null default now()
);

create table public.inventory_items (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  sku text unique,
  unit text not null default 'unit',
  stock_qty numeric(14,3) not null default 0,
  min_threshold numeric(14,3) not null default 0,
  supplier_name text,
  created_at timestamptz not null default now()
);

create table public.recipe_components (
  id uuid primary key default gen_random_uuid(),
  menu_item_id uuid not null references public.menu_items(id) on delete cascade,
  inventory_item_id uuid not null references public.inventory_items(id) on delete restrict,
  qty_per_unit numeric(14,3) not null check (qty_per_unit > 0),
  unique (menu_item_id, inventory_item_id)
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
  status app.order_status not null default 'pending',
  subtotal_cents integer not null default 0 check (subtotal_cents >= 0),
  tax_cents integer not null default 0 check (tax_cents >= 0),
  total_cents integer not null default 0 check (total_cents >= 0),
  payment_method text,
  paid_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index orders_created_idx on public.orders(created_at desc);
create index orders_status_idx on public.orders(status);

create table public.order_lines (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete cascade,
  menu_item_id uuid references public.menu_items(id) on delete set null,
  name_snapshot text not null,
  unit_price_cents integer not null check (unit_price_cents >= 0),
  qty integer not null check (qty > 0),
  line_total_cents integer not null check (line_total_cents >= 0),
  modifiers jsonb not null default '[]'::jsonb,
  kds_status app.line_status not null default 'queued',
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

-- ── RLS: staff read, owner/manager write ──────────────────────────────────
do $$
declare tbl text;
begin
  foreach tbl in array array[
    'memberships','menu_categories','menu_items','inventory_items',
    'recipe_components','reservations','restaurant_tables'
  ] loop
    execute format('alter table public.%I enable row level security;', tbl);
    execute format(
      'create policy staff_read on public.%I for select using (app.is_staff());', tbl);
    execute format(
      'create policy mgr_write on public.%I for all using (app.can_write()) with check (app.can_write());', tbl);
  end loop;
end $$;

-- orders / order_lines: any staff reads and updates (KDS, counter). Inserts via place_order().
alter table public.orders enable row level security;
create policy staff_read on public.orders for select using (app.is_staff());
create policy staff_update on public.orders for update using (app.is_staff()) with check (app.is_staff());

alter table public.order_lines enable row level security;
create policy staff_read on public.order_lines for select using (app.is_staff());
create policy staff_update on public.order_lines for update using (app.is_staff()) with check (app.is_staff());

alter table public.stock_ledger enable row level security;
create policy staff_read on public.stock_ledger for select using (app.is_staff());

alter table public.order_counter enable row level security; -- functions only
alter table public.outbox enable row level security;        -- service_role only

alter table public.table_sessions enable row level security;
create policy staff_read on public.table_sessions for select using (app.is_staff());
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
  comment      text,
  created_at   timestamptz not null default now()
);
alter table public.feedback enable row level security;
create policy guest_insert on public.feedback for insert with check (true);
create policy staff_read on public.feedback for select using (app.is_staff());

-- ── Functions ────────────────────────────────────────────────────────────
create or replace function public.adjust_stock(
  p_inventory_item_id uuid, p_delta numeric, p_reason text, p_note text default null
) returns numeric
language plpgsql security definer set search_path = public, app as $$
declare v_new numeric;
begin
  if not app.can_write() and app.current_member_role() is not null then
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

create or replace function public.place_order(
  p_channel text, p_table_label text, p_customer_name text,
  p_tax_rate_bps integer, p_lines jsonb,
  p_discount_cents int default 0, p_promo_code text default null
) returns table (order_id uuid, order_number bigint, subtotal_cents int, discount_cents int, tax_cents int, total_cents int)
language plpgsql security definer set search_path = public, app as $$
declare
  v_order_id uuid; v_no bigint; v_sub int := 0; v_tax int; v_total int;
  v_line jsonb; v_mi record; v_qty int; v_lt int; v_comp record; v_need numeric; v_upd int;
  v_session_id uuid; v_disc int := greatest(0, coalesce(p_discount_cents, 0));
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

    select id, name, price_cents, is_available into v_mi
      from public.menu_items where id = (v_line->>'menu_item_id')::uuid;
    if not found then raise exception 'menu_item_not_found: %', v_line->>'menu_item_id' using errcode = 'foreign_key_violation'; end if;
    if not v_mi.is_available then raise exception 'menu_item_unavailable: %', v_mi.name using errcode = 'check_violation'; end if;

    v_lt := v_mi.price_cents * v_qty;
    v_sub := v_sub + v_lt;

    insert into public.order_lines (order_id, menu_item_id, name_snapshot, unit_price_cents, qty, line_total_cents, modifiers)
    values (v_order_id, v_mi.id, v_mi.name, v_mi.price_cents, v_qty, v_lt, coalesce(v_line->'modifiers','[]'::jsonb));

    for v_comp in select inventory_item_id, qty_per_unit from public.recipe_components where menu_item_id = v_mi.id loop
      v_need := v_comp.qty_per_unit * v_qty;
      update public.inventory_items set stock_qty = stock_qty - v_need
       where id = v_comp.inventory_item_id and stock_qty >= v_need;
      get diagnostics v_upd = row_count;
      if v_upd = 0 then raise exception 'insufficient_stock: %', v_comp.inventory_item_id using errcode = 'check_violation'; end if;
      insert into public.stock_ledger (inventory_item_id, delta_qty, reason, order_id)
      values (v_comp.inventory_item_id, -v_need, 'order_deduction', v_order_id);
    end loop;
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
    tax_cents = v_tax, total_cents = v_total,
    status = 'in_kitchen', updated_at = now() where id = v_order_id;

  insert into public.outbox (topic, payload) values ('order.placed', jsonb_build_object(
    'order_id', v_order_id, 'order_number', v_no, 'total_cents', v_total, 'table_label', p_table_label));

  return query select v_order_id, v_no, v_sub, v_disc, v_tax, v_total;
end $$;
revoke all on function public.place_order(text, text, text, integer, jsonb, int, text) from public;
grant execute on function public.place_order(text, text, text, integer, jsonb, int, text) to authenticated, service_role, anon;

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
create policy staff_read on public.promotions for select using (app.is_staff());
create policy mgr_write on public.promotions for all using (app.can_write()) with check (app.can_write());
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
create policy staff_read on public.suppliers for select using (app.is_staff());
create policy mgr_write on public.suppliers for all using (app.can_write()) with check (app.can_write());
create policy staff_read on public.purchase_orders for select using (app.is_staff());
create policy mgr_write on public.purchase_orders for all using (app.can_write()) with check (app.can_write());
create policy staff_read on public.purchase_order_lines for select using (app.is_staff());
create policy mgr_write on public.purchase_order_lines for all using (app.can_write()) with check (app.can_write());

create or replace function public.next_po_number() returns bigint
language plpgsql security definer set search_path = public, app as $fn$
declare v bigint;
begin
  update public.po_counter set next_number = next_number + 1 where id returning next_number - 1 into v;
  return v;
end $fn$;
grant execute on function public.next_po_number() to authenticated, service_role;

-- Receive a PO: add each line's outstanding qty to inventory + ledger, mark received.
create or replace function public.receive_purchase_order(p_po_id uuid) returns void
language plpgsql security definer set search_path = public, app as $fn$
declare r record;
begin
  if not app.can_write() and app.current_member_role() is not null then
    raise exception 'forbidden' using errcode = 'insufficient_privilege';
  end if;
  for r in
    select id, inventory_item_id, qty, received_qty from public.purchase_order_lines
    where purchase_order_id = p_po_id
  loop
    if r.inventory_item_id is not null and r.qty > r.received_qty then
      update public.inventory_items set stock_qty = stock_qty + (r.qty - r.received_qty)
       where id = r.inventory_item_id;
      insert into public.stock_ledger (inventory_item_id, delta_qty, reason, note)
      values (r.inventory_item_id, r.qty - r.received_qty, 'restock', 'PO receipt');
    end if;
    update public.purchase_order_lines set received_qty = qty where id = r.id;
  end loop;
  update public.purchase_orders set status = 'received', received_at = now() where id = p_po_id;
end $fn$;
grant execute on function public.receive_purchase_order(uuid) to authenticated, service_role;

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
  clock_in      timestamptz not null default now(),
  clock_out     timestamptz,
  note          text
);
create index attendance_member_idx on public.attendance(membership_id, clock_in desc);

alter table public.shifts enable row level security;
alter table public.attendance enable row level security;
create policy staff_read on public.shifts for select using (app.is_staff());
create policy mgr_write on public.shifts for all using (app.can_write()) with check (app.can_write());
-- any staff member sees attendance; management (or HR) writes; a member may clock themselves
create policy staff_read on public.attendance for select using (app.is_staff());
create policy mgr_write on public.attendance for all using (app.can_write()) with check (app.can_write());

-- ── Audit log ────────────────────────────────────────────────────────────
create table public.audit_logs (
  id          bigint generated always as identity primary key,
  actor_id    uuid,
  actor_email text,
  actor_role  text,
  action      text not null,   -- INSERT | UPDATE | DELETE
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
    actor_id, actor_email, actor_role, action, entity, entity_id, before, after
  ) values (
    (v_claims #>> '{sub}')::uuid,
    v_claims #>> '{email}',
    app.current_member_role(),
    tg_op,
    tg_table_name,
    coalesce(to_jsonb(new) ->> 'id', to_jsonb(old) ->> 'id'),
    case when tg_op in ('UPDATE', 'DELETE') then to_jsonb(old) end,
    case when tg_op in ('UPDATE', 'INSERT') then to_jsonb(new) end
  );
  return coalesce(new, old);
end $fn$;

do $$
declare tbl text;
begin
  foreach tbl in array array[
    'menu_categories','menu_items','inventory_items','recipe_components',
    'memberships','restaurant_tables','reservations',
    'promotions','suppliers','purchase_orders','shifts'
  ] loop
    execute format(
      'create trigger audit after insert or update or delete on public.%I for each row execute function app.audit_row();',
      tbl
    );
  end loop;
end $$;

-- ── Seed ─────────────────────────────────────────────────────────────────
insert into public.menu_categories (name) values ('Uncategorised');
