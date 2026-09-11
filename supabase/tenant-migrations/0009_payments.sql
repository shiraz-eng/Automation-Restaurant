-- ============================================================================
-- Tenant delta 0009 — P4: payments, refunds & sensitive order actions
--
--   * public.payments  — one row per payment event against an order.
--   * public.refunds   — full/partial refunds against a payment (reason required).
--   * public.order_adjustments — audit-preserving log of discount / price
--     override / void / reopen (never silently rewrite financial history).
--   * orders gains tax_rate_bps (captured at creation) + refunded_cents.
--   * RPCs (SECURITY DEFINER, each gated by app.has_perm): record_payment,
--     refund_payment, void_payment, cancel_order, apply_order_discount,
--     override_line_price, reopen_order — callable directly from the tenant
--     client; the permission check is inside the function.
--
-- Depends on 0006 (payments.* / orders.* keys). Idempotent.
-- ============================================================================

alter table public.orders add column if not exists tax_rate_bps  int not null default 0;
alter table public.orders add column if not exists refunded_cents int not null default 0 check (refunded_cents >= 0);

create table if not exists public.payments (
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
create index if not exists payments_order_idx on public.payments(order_id);

create table if not exists public.refunds (
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
create index if not exists refunds_order_idx on public.refunds(order_id);

create table if not exists public.order_adjustments (
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
create index if not exists order_adjustments_order_idx on public.order_adjustments(order_id, created_at desc);

-- ── Helpers ───────────────────────────────────────────────────────────────
create or replace function app.jwt_sub() returns uuid language sql stable as $$
  select nullif(nullif(current_setting('request.jwt.claims', true), '')::jsonb #>> '{sub}', '')::uuid
$$;

create or replace function app.recalc_order_totals(p_order_id uuid) returns void
language plpgsql set search_path = public, app as $$
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
end $$;

-- ── Payment / refund / void ───────────────────────────────────────────────
create or replace function public.record_payment(
  p_order_id uuid, p_amount_cents int, p_method text default 'cash',
  p_tendered_cents int default null, p_reference text default null
) returns public.payments
language plpgsql security definer set search_path = public, app as $$
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
end $$;
revoke all on function public.record_payment(uuid, int, text, int, text) from public;
grant execute on function public.record_payment(uuid, int, text, int, text) to authenticated, service_role;

create or replace function public.refund_payment(
  p_payment_id uuid, p_amount_cents int, p_reason text, p_method text default null
) returns public.refunds
language plpgsql security definer set search_path = public, app as $$
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
end $$;
revoke all on function public.refund_payment(uuid, int, text, text) from public;
grant execute on function public.refund_payment(uuid, int, text, text) to authenticated, service_role;

create or replace function public.void_payment(p_payment_id uuid, p_reason text)
returns void language plpgsql security definer set search_path = public, app as $$
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
end $$;
revoke all on function public.void_payment(uuid, text) from public;
grant execute on function public.void_payment(uuid, text) to authenticated, service_role;

-- ── Sensitive order actions ───────────────────────────────────────────────
create or replace function public.cancel_order(p_order_id uuid, p_reason text)
returns void language plpgsql security definer set search_path = public, app as $$
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
end $$;
revoke all on function public.cancel_order(uuid, text) from public;
grant execute on function public.cancel_order(uuid, text) to authenticated, service_role;

create or replace function public.apply_order_discount(p_order_id uuid, p_discount_cents int, p_reason text)
returns void language plpgsql security definer set search_path = public, app as $$
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
end $$;
revoke all on function public.apply_order_discount(uuid, int, text) from public;
grant execute on function public.apply_order_discount(uuid, int, text) to authenticated, service_role;

create or replace function public.override_line_price(p_line_id uuid, p_unit_price_cents int, p_reason text)
returns void language plpgsql security definer set search_path = public, app as $$
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
end $$;
revoke all on function public.override_line_price(uuid, int, text) from public;
grant execute on function public.override_line_price(uuid, int, text) to authenticated, service_role;

create or replace function public.reopen_order(p_order_id uuid, p_reason text)
returns void language plpgsql security definer set search_path = public, app as $$
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
end $$;
revoke all on function public.reopen_order(uuid, text) from public;
grant execute on function public.reopen_order(uuid, text) to authenticated, service_role;

-- ── place_order: capture the tax rate on the order (for later recalculation) ─
create or replace function public.place_order(
  p_channel text, p_table_label text, p_customer_name text,
  p_tax_rate_bps integer, p_lines jsonb,
  p_discount_cents int default 0, p_promo_code text default null
) returns table (order_id uuid, order_number bigint, subtotal_cents int, discount_cents int, tax_cents int, total_cents int)
language plpgsql security definer set search_path = public, app as $$
declare
  v_order_id uuid; v_no bigint; v_sub int := 0; v_tax int; v_total int;
  v_line jsonb; v_qty int; v_lt int; v_comp record; v_need numeric; v_upd int;
  v_session_id uuid; v_disc int := greatest(0, coalesce(p_discount_cents, 0));
  v_variant_id uuid; v_item_id uuid; v_item_name text; v_variant_name text;
  v_price int; v_avail boolean;
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

    v_variant_id := nullif(v_line->>'variant_id', '')::uuid;
    if v_variant_id is not null then
      select v.id, v.menu_item_id, i.name, v.name, v.price_cents, (v.is_available and i.is_available)
        into v_variant_id, v_item_id, v_item_name, v_variant_name, v_price, v_avail
        from public.menu_variants v join public.menu_items i on i.id = v.menu_item_id
       where v.id = v_variant_id;
      if not found then raise exception 'variant_not_found: %', v_line->>'variant_id' using errcode = 'foreign_key_violation'; end if;
    else
      v_item_id := (v_line->>'menu_item_id')::uuid;
      select i.name, i.is_available, i.price_cents into v_item_name, v_avail, v_price
        from public.menu_items i where i.id = v_item_id;
      if not found then raise exception 'menu_item_not_found: %', v_line->>'menu_item_id' using errcode = 'foreign_key_violation'; end if;
      select v.id, v.name, v.price_cents, (v.is_available and v_avail)
        into v_variant_id, v_variant_name, v_price, v_avail
        from public.menu_variants v where v.menu_item_id = v_item_id
       order by v.sort_order, v.created_at limit 1;
    end if;

    if not coalesce(v_avail, false) then
      raise exception 'item_unavailable: %', coalesce(v_item_name, v_item_id::text) using errcode = 'check_violation';
    end if;

    v_lt := v_price * v_qty;
    v_sub := v_sub + v_lt;

    insert into public.order_lines
      (order_id, menu_item_id, variant_id, name_snapshot, variant_name_snapshot, unit_price_cents, qty, line_total_cents, modifiers)
    values
      (v_order_id, v_item_id, v_variant_id,
       v_item_name || case when v_variant_name is not null and v_variant_name <> 'Regular' then ' · ' || v_variant_name else '' end,
       v_variant_name, v_price, v_qty, v_lt, coalesce(v_line->'modifiers','[]'::jsonb));

    if v_variant_id is not null then
      update public.menu_variants
         set available_qty = greatest(0, available_qty - v_qty)
       where id = v_variant_id and track_availability;
    end if;

    for v_comp in select inventory_item_id, qty_per_unit from public.recipe_components where menu_item_id = v_item_id loop
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
    tax_cents = v_tax, total_cents = v_total, tax_rate_bps = coalesce(p_tax_rate_bps, 0),
    status = 'in_kitchen', updated_at = now() where id = v_order_id;

  insert into public.outbox (topic, payload) values ('order.placed', jsonb_build_object(
    'order_id', v_order_id, 'order_number', v_no, 'total_cents', v_total, 'table_label', p_table_label));

  return query select v_order_id, v_no, v_sub, v_disc, v_tax, v_total;
end $$;
revoke all on function public.place_order(text, text, text, integer, jsonb, int, text) from public;
grant execute on function public.place_order(text, text, text, integer, jsonb, int, text) to authenticated, service_role, anon;

-- ── RLS + realtime + audit ────────────────────────────────────────────────
alter table public.payments enable row level security;
alter table public.refunds enable row level security;
alter table public.order_adjustments enable row level security;
drop policy if exists staff_read on public.payments;
drop policy if exists staff_read on public.refunds;
drop policy if exists staff_read on public.order_adjustments;
create policy staff_read on public.payments for select using (app.has_perm('payments.view') or app.is_staff());
create policy staff_read on public.refunds for select using (app.has_perm('payments.view') or app.is_staff());
create policy staff_read on public.order_adjustments for select using (app.has_perm('orders.view') or app.is_staff());

do $$ begin execute 'alter publication supabase_realtime add table public.payments';
exception when duplicate_object then null; end $$;

do $$
declare tbl text;
begin
  foreach tbl in array array['payments','refunds','order_adjustments'] loop
    execute format('drop trigger if exists audit on public.%I;', tbl);
    execute format('create trigger audit after insert or update or delete on public.%I for each row execute function app.audit_row();', tbl);
  end loop;
end $$;
