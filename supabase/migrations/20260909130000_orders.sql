-- ============================================================================
-- 0002_orders.sql  ·  Automation Restaurant
-- Order pipeline: orders, line items, BOM, append-only stock ledger, outbox.
--
-- RULE-SYNC-02 done safely: place_order() writes the order + line items +
-- guarded inventory deduction + ledger rows in ONE transaction, then enqueues a
-- single `order.placed` event in the outbox. A worker drains the outbox and
-- delivers to the Counter and KDS consumers. No synchronous cross-portal writes.
-- ============================================================================

create type app.order_channel as enum ('dine_in', 'takeaway', 'delivery');
create type app.order_status  as enum ('pending', 'in_kitchen', 'ready', 'served', 'paid', 'void');
create type app.line_status   as enum ('queued', 'preparing', 'ready', 'served');
create type app.stock_reason  as enum ('order_deduction', 'restock', 'adjustment', 'spoilage', 'stock_take');

-- ── Per-tenant human-friendly order numbering ──────────────────────────────
create table public.tenant_counters (
  tenant_id         uuid primary key references public.tenants(id) on delete cascade,
  next_order_number bigint not null default 1
);

-- ── BOM: inventory each menu item consumes per unit sold ───────────────────
create table public.recipe_components (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references public.tenants(id) on delete cascade,
  menu_item_id      uuid not null references public.menu_items(id) on delete cascade,
  inventory_item_id uuid not null references public.inventory_items(id) on delete restrict,
  qty_per_unit      numeric(14,3) not null check (qty_per_unit > 0),
  unique (menu_item_id, inventory_item_id)
);
create index recipe_components_tenant_idx on public.recipe_components(tenant_id);
create index recipe_components_menu_item_idx on public.recipe_components(menu_item_id);

-- ── Orders ────────────────────────────────────────────────────────────────
create table public.orders (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references public.tenants(id) on delete cascade,
  order_number   bigint not null,
  branch_id      uuid,
  channel        app.order_channel not null default 'dine_in',
  table_label    text,
  customer_name  text,
  status         app.order_status not null default 'pending',
  subtotal_cents integer not null default 0 check (subtotal_cents >= 0),
  tax_cents      integer not null default 0 check (tax_cents >= 0),
  total_cents    integer not null default 0 check (total_cents >= 0),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (tenant_id, order_number)
);
create index orders_tenant_created_idx on public.orders(tenant_id, created_at desc);
create index orders_tenant_status_idx on public.orders(tenant_id, status);

create table public.order_lines (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references public.tenants(id) on delete cascade,
  order_id         uuid not null references public.orders(id) on delete cascade,
  menu_item_id     uuid references public.menu_items(id) on delete set null,
  name_snapshot    text not null,
  unit_price_cents integer not null check (unit_price_cents >= 0),
  qty              integer not null check (qty > 0),
  line_total_cents integer not null check (line_total_cents >= 0),
  modifiers        jsonb not null default '[]'::jsonb,
  kds_status       app.line_status not null default 'queued',
  created_at       timestamptz not null default now()
);
create index order_lines_order_idx on public.order_lines(order_id);
create index order_lines_tenant_kds_idx on public.order_lines(tenant_id, kds_status);

-- ── Append-only stock ledger (source of truth for stock history) ───────────
create table public.stock_ledger (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references public.tenants(id) on delete cascade,
  inventory_item_id uuid not null references public.inventory_items(id) on delete restrict,
  delta_qty         numeric(14,3) not null,   -- negative = consumed
  reason            app.stock_reason not null,
  order_id          uuid references public.orders(id) on delete set null,
  note              text,
  created_at        timestamptz not null default now()
);
create index stock_ledger_tenant_item_idx on public.stock_ledger(tenant_id, inventory_item_id, created_at desc);

-- ── Outbox (service_role only; drained by a worker) ───────────────────────
create table public.outbox (
  id           bigint generated always as identity primary key,
  tenant_id    uuid not null references public.tenants(id) on delete cascade,
  topic        text not null,
  payload      jsonb not null,
  created_at   timestamptz not null default now(),
  processed_at timestamptz,
  attempts     int not null default 0,
  last_error   text
);
create index outbox_unprocessed_idx on public.outbox(created_at) where processed_at is null;

-- ── RLS ───────────────────────────────────────────────────────────────────
alter table public.tenant_counters   enable row level security;  -- functions only
alter table public.recipe_components enable row level security;
alter table public.orders            enable row level security;
alter table public.order_lines       enable row level security;
alter table public.stock_ledger      enable row level security;
alter table public.outbox            enable row level security;  -- service_role only

create policy tenant_read on public.recipe_components
  for select using (tenant_id = app.current_tenant_id());
create policy tenant_write on public.recipe_components
  for all using (tenant_id = app.current_tenant_id())
  with check (tenant_id = app.current_tenant_id()
    and app.current_member_role() in ('owner', 'manager'));

-- Orders/lines: any tenant member reads and updates (KDS marks lines ready,
-- counter marks paid). Inserts happen only through place_order().
create policy tenant_read on public.orders
  for select using (tenant_id = app.current_tenant_id());
create policy tenant_update on public.orders
  for update using (tenant_id = app.current_tenant_id() and app.current_member_role() is not null)
  with check (tenant_id = app.current_tenant_id());

create policy tenant_read on public.order_lines
  for select using (tenant_id = app.current_tenant_id());
create policy tenant_update on public.order_lines
  for update using (tenant_id = app.current_tenant_id() and app.current_member_role() is not null)
  with check (tenant_id = app.current_tenant_id());

-- Stock ledger: readable by tenant members, immutable (no update/delete policy),
-- inserted only through functions.
create policy tenant_read on public.stock_ledger
  for select using (tenant_id = app.current_tenant_id());

-- ── adjust_stock: restock / spoilage / corrections ───────────────────────
create or replace function public.adjust_stock(
  p_tenant_id         uuid,
  p_inventory_item_id uuid,
  p_delta             numeric,
  p_reason            text,
  p_note              text default null
)
returns numeric
language plpgsql
security definer
set search_path = public, app
as $$
declare
  v_caller uuid := app.current_tenant_id();
  v_new    numeric;
begin
  if v_caller is not null then
    if v_caller <> p_tenant_id then
      raise exception 'tenant_mismatch' using errcode = 'insufficient_privilege';
    end if;
    if app.current_member_role() not in ('owner', 'manager') then
      raise exception 'forbidden' using errcode = 'insufficient_privilege';
    end if;
  end if;

  update public.inventory_items
     set stock_qty = stock_qty + p_delta
   where id = p_inventory_item_id and tenant_id = p_tenant_id
  returning stock_qty into v_new;
  if not found then
    raise exception 'inventory_item_not_found' using errcode = 'foreign_key_violation';
  end if;
  if v_new < 0 then
    raise exception 'would_go_negative' using errcode = 'check_violation';
  end if;

  insert into public.stock_ledger (tenant_id, inventory_item_id, delta_qty, reason, note)
  values (p_tenant_id, p_inventory_item_id, p_delta,
          coalesce(nullif(p_reason, ''), 'adjustment')::app.stock_reason, p_note);

  return v_new;
end;
$$;

revoke all on function public.adjust_stock(uuid, uuid, numeric, text, text) from public;
grant execute on function public.adjust_stock(uuid, uuid, numeric, text, text) to authenticated, service_role;

-- ── place_order: the atomic order + BOM deduction + outbox event ─────────
create or replace function public.place_order(
  p_tenant_id     uuid,
  p_channel       text,
  p_table_label   text,
  p_customer_name text,
  p_tax_rate_bps  integer,   -- basis points; 800 = 8.00%
  p_lines         jsonb      -- [{ "menu_item_id": uuid, "qty": int, "modifiers": [...] }]
)
returns table (order_id uuid, order_number bigint, subtotal_cents int, tax_cents int, total_cents int)
language plpgsql
security definer
set search_path = public, app
as $$
declare
  v_caller     uuid := app.current_tenant_id();
  v_order_id   uuid;
  v_order_no   bigint;
  v_subtotal   int := 0;
  v_tax        int;
  v_total      int;
  v_line       jsonb;
  v_mi         record;
  v_qty        int;
  v_line_total int;
  v_comp       record;
  v_need       numeric;
  v_updated    int;
begin
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'no_lines' using errcode = 'check_violation';
  end if;

  -- A logged-in user may only order for their own tenant. service_role has no
  -- JWT tenant claim and is trusted to pass any tenant id (customer portal path).
  if v_caller is not null and v_caller <> p_tenant_id then
    raise exception 'tenant_mismatch' using errcode = 'insufficient_privilege';
  end if;

  insert into public.tenant_counters (tenant_id, next_order_number)
  values (p_tenant_id, 2)
  on conflict (tenant_id)
    do update set next_order_number = public.tenant_counters.next_order_number + 1
  returning next_order_number - 1 into v_order_no;

  insert into public.orders (tenant_id, order_number, channel, table_label, customer_name, status)
  values (p_tenant_id, v_order_no,
          coalesce(nullif(p_channel, ''), 'dine_in')::app.order_channel,
          p_table_label, p_customer_name, 'pending')
  returning id into v_order_id;

  for v_line in select value from jsonb_array_elements(p_lines) as t(value)
  loop
    v_qty := coalesce((v_line->>'qty')::int, 0);
    if v_qty <= 0 then
      raise exception 'bad_qty' using errcode = 'check_violation';
    end if;

    select id, name, price_cents, is_available
      into v_mi
      from public.menu_items
     where id = (v_line->>'menu_item_id')::uuid and tenant_id = p_tenant_id;
    if not found then
      raise exception 'menu_item_not_found: %', v_line->>'menu_item_id'
        using errcode = 'foreign_key_violation';
    end if;
    if not v_mi.is_available then
      raise exception 'menu_item_unavailable: %', v_mi.name using errcode = 'check_violation';
    end if;

    v_line_total := v_mi.price_cents * v_qty;
    v_subtotal := v_subtotal + v_line_total;

    insert into public.order_lines (
      tenant_id, order_id, menu_item_id, name_snapshot,
      unit_price_cents, qty, line_total_cents, modifiers
    ) values (
      p_tenant_id, v_order_id, v_mi.id, v_mi.name,
      v_mi.price_cents, v_qty, v_line_total,
      coalesce(v_line->'modifiers', '[]'::jsonb)
    );

    -- BOM: consume inventory, guarded so it can never oversell or go negative.
    for v_comp in
      select inventory_item_id, qty_per_unit
        from public.recipe_components
       where menu_item_id = v_mi.id and tenant_id = p_tenant_id
    loop
      v_need := v_comp.qty_per_unit * v_qty;

      update public.inventory_items
         set stock_qty = stock_qty - v_need
       where id = v_comp.inventory_item_id
         and tenant_id = p_tenant_id
         and stock_qty >= v_need;
      get diagnostics v_updated = row_count;
      if v_updated = 0 then
        raise exception 'insufficient_stock: inventory_item %', v_comp.inventory_item_id
          using errcode = 'check_violation';
      end if;

      insert into public.stock_ledger (tenant_id, inventory_item_id, delta_qty, reason, order_id)
      values (p_tenant_id, v_comp.inventory_item_id, -v_need, 'order_deduction', v_order_id);
    end loop;
  end loop;

  v_tax   := round(v_subtotal::numeric * coalesce(p_tax_rate_bps, 0) / 10000)::int;
  v_total := v_subtotal + v_tax;

  update public.orders
     set subtotal_cents = v_subtotal,
         tax_cents      = v_tax,
         total_cents    = v_total,
         status         = 'in_kitchen',
         updated_at     = now()
   where id = v_order_id;

  insert into public.outbox (tenant_id, topic, payload)
  values (
    p_tenant_id, 'order.placed',
    jsonb_build_object(
      'order_id', v_order_id,
      'order_number', v_order_no,
      'channel', coalesce(nullif(p_channel, ''), 'dine_in'),
      'table_label', p_table_label,
      'customer_name', p_customer_name,
      'subtotal_cents', v_subtotal,
      'tax_cents', v_tax,
      'total_cents', v_total,
      'lines', (
        select coalesce(jsonb_agg(jsonb_build_object(
                 'name', ol.name_snapshot,
                 'qty', ol.qty,
                 'unit_price_cents', ol.unit_price_cents,
                 'line_total_cents', ol.line_total_cents,
                 'modifiers', ol.modifiers)), '[]'::jsonb)
          from public.order_lines ol
         where ol.order_id = v_order_id
      )
    )
  );

  return query select v_order_id, v_order_no, v_subtotal, v_tax, v_total;
end;
$$;

revoke all on function public.place_order(uuid, text, text, text, integer, jsonb) from public;
grant execute on function public.place_order(uuid, text, text, text, integer, jsonb) to authenticated, service_role;
