-- ============================================================================
-- Tenant delta 0002 — Promotions, Suppliers & Purchasing, Shifts & Attendance
--
-- Applied to tenant projects that were provisioned before these features
-- existed. New projects get everything from tenant-template/schema.sql.
-- Idempotent where practical (if not exists / drop-then-create).
-- ============================================================================

-- ── Promotions ───────────────────────────────────────────────────────────
do $$ begin
  create type app.promo_kind as enum ('percent', 'fixed');
exception when duplicate_object then null; end $$;

create table if not exists public.promotions (
  id                 uuid primary key default gen_random_uuid(),
  name               text not null,
  kind               app.promo_kind not null default 'percent',
  value_bps          int check (value_bps between 0 and 10000),
  value_cents        int check (value_cents >= 0),
  code               text unique,
  min_subtotal_cents int not null default 0,
  active             boolean not null default true,
  starts_at          timestamptz,
  ends_at            timestamptz,
  created_at         timestamptz not null default now()
);

alter table public.orders add column if not exists discount_cents int not null default 0 check (discount_cents >= 0);
alter table public.orders add column if not exists promo_code text;

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
drop policy if exists staff_read on public.promotions;
drop policy if exists mgr_write on public.promotions;
drop policy if exists guest_read on public.promotions;
create policy staff_read on public.promotions for select using (app.is_staff());
create policy mgr_write on public.promotions for all using (app.can_write()) with check (app.can_write());
create policy guest_read on public.promotions for select using (active);

-- ── place_order gains discount params ────────────────────────────────────
drop function if exists public.place_order(text, text, text, integer, jsonb);

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

-- ── Suppliers & purchasing ───────────────────────────────────────────────
do $$ begin
  create type app.po_status as enum ('draft', 'sent', 'partial', 'received', 'cancelled');
exception when duplicate_object then null; end $$;

create table if not exists public.suppliers (
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

create table if not exists public.po_counter (
  id boolean primary key default true check (id),
  next_number bigint not null default 1
);
insert into public.po_counter default values on conflict do nothing;

create table if not exists public.purchase_orders (
  id          uuid primary key default gen_random_uuid(),
  po_number   bigint not null unique,
  supplier_id uuid references public.suppliers(id) on delete set null,
  status      app.po_status not null default 'draft',
  expected_at date,
  notes       text,
  created_at  timestamptz not null default now(),
  received_at timestamptz
);

create table if not exists public.purchase_order_lines (
  id                uuid primary key default gen_random_uuid(),
  purchase_order_id uuid not null references public.purchase_orders(id) on delete cascade,
  inventory_item_id uuid references public.inventory_items(id) on delete set null,
  description       text not null,
  qty               numeric(14,3) not null check (qty > 0),
  unit_cost_cents   int not null default 0 check (unit_cost_cents >= 0),
  received_qty      numeric(14,3) not null default 0
);
create index if not exists po_lines_po_idx on public.purchase_order_lines(purchase_order_id);

alter table public.suppliers enable row level security;
alter table public.purchase_orders enable row level security;
alter table public.purchase_order_lines enable row level security;
alter table public.po_counter enable row level security;
drop policy if exists staff_read on public.suppliers;
drop policy if exists mgr_write on public.suppliers;
drop policy if exists staff_read on public.purchase_orders;
drop policy if exists mgr_write on public.purchase_orders;
drop policy if exists staff_read on public.purchase_order_lines;
drop policy if exists mgr_write on public.purchase_order_lines;
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
create table if not exists public.shifts (
  id            uuid primary key default gen_random_uuid(),
  membership_id uuid not null references public.memberships(id) on delete cascade,
  starts_at     timestamptz not null,
  ends_at       timestamptz not null,
  role_label    text,
  notes         text,
  created_at    timestamptz not null default now(),
  check (ends_at > starts_at)
);
create index if not exists shifts_time_idx on public.shifts(starts_at);

create table if not exists public.attendance (
  id            uuid primary key default gen_random_uuid(),
  membership_id uuid not null references public.memberships(id) on delete cascade,
  clock_in      timestamptz not null default now(),
  clock_out     timestamptz,
  note          text
);
create index if not exists attendance_member_idx on public.attendance(membership_id, clock_in desc);

alter table public.shifts enable row level security;
alter table public.attendance enable row level security;
drop policy if exists staff_read on public.shifts;
drop policy if exists mgr_write on public.shifts;
drop policy if exists staff_read on public.attendance;
drop policy if exists mgr_write on public.attendance;
create policy staff_read on public.shifts for select using (app.is_staff());
create policy mgr_write on public.shifts for all using (app.can_write()) with check (app.can_write());
create policy staff_read on public.attendance for select using (app.is_staff());
create policy mgr_write on public.attendance for all using (app.can_write()) with check (app.can_write());

-- ── Audit triggers for the new config tables ────────────────────────────
do $$
declare tbl text;
begin
  foreach tbl in array array['promotions','suppliers','purchase_orders','shifts'] loop
    execute format('drop trigger if exists audit on public.%I;', tbl);
    execute format(
      'create trigger audit after insert or update or delete on public.%I for each row execute function app.audit_row();',
      tbl
    );
  end loop;
end $$;
