-- ============================================================================
-- Tenant delta 0010 — P5: Kitchen Portal
--
--   * orders.customer_note + order_lines.customer_note (<=500 chars, untrusted
--     text; place_order stores what the storefront sends).
--   * app.log_action() — RPC-level audit_logs writer (the row trigger only
--     covers table DML).
--   * Kitchen status RPCs (SECURITY DEFINER, gated by kitchen.update_status,
--     reject void/paid orders): kitchen_start_order, kitchen_mark_ready,
--     kitchen_complete_order, kitchen_set_line_status.
--   * Food availability: food_stock_log + set_food_stock / set_variant_available
--     / record_waste (kitchen.manage_availability / kitchen.record_waste).
--
-- Depends on 0006 (kitchen.* keys) + 0009 (current place_order). Idempotent.
-- ============================================================================

alter table public.orders      add column if not exists customer_note text;
alter table public.order_lines add column if not exists customer_note text;

-- ── RPC-level audit writer ────────────────────────────────────────────────
create or replace function app.log_action(
  p_action text, p_entity text, p_entity_id text,
  p_before jsonb default null, p_after jsonb default null
) returns void language plpgsql security definer set search_path = public, app as $$
declare v_claims jsonb := nullif(current_setting('request.jwt.claims', true), '')::jsonb;
begin
  insert into public.audit_logs
    (actor_id, actor_email, actor_role, action, entity, entity_id, before, after)
  values
    (app.jwt_sub(), v_claims #>> '{email}', app.current_member_role(),
     p_action, p_entity, p_entity_id, p_before, p_after);
end $$;

-- ── Kitchen status transitions ───────────────────────────────────────────
create or replace function public.kitchen_start_order(p_order_id uuid)
returns void language plpgsql security definer set search_path = public, app as $$
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
end $$;
revoke all on function public.kitchen_start_order(uuid) from public;
grant execute on function public.kitchen_start_order(uuid) to authenticated, service_role;

create or replace function public.kitchen_mark_ready(p_order_id uuid)
returns void language plpgsql security definer set search_path = public, app as $$
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
end $$;
revoke all on function public.kitchen_mark_ready(uuid) from public;
grant execute on function public.kitchen_mark_ready(uuid) to authenticated, service_role;

create or replace function public.kitchen_complete_order(p_order_id uuid)
returns void language plpgsql security definer set search_path = public, app as $$
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
end $$;
revoke all on function public.kitchen_complete_order(uuid) from public;
grant execute on function public.kitchen_complete_order(uuid) to authenticated, service_role;

create or replace function public.kitchen_set_line_status(p_line_id uuid, p_status text)
returns void language plpgsql security definer set search_path = public, app as $$
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
end $$;
revoke all on function public.kitchen_set_line_status(uuid, text) from public;
grant execute on function public.kitchen_set_line_status(uuid, text) to authenticated, service_role;

-- ── Food availability & waste ────────────────────────────────────────────
create table if not exists public.food_stock_log (
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
create index if not exists food_stock_log_variant_idx on public.food_stock_log(variant_id, created_at desc);
alter table public.food_stock_log enable row level security;
drop policy if exists staff_read on public.food_stock_log;
create policy staff_read on public.food_stock_log for select using (app.has_perm('stock.view') or app.is_staff());

create or replace function public.set_food_stock(
  p_variant_id uuid, p_new_qty int, p_reason text, p_note text default null
) returns void language plpgsql security definer set search_path = public, app as $$
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
         is_available = case
           when p_reason = 'out_of_stock' or p_new_qty = 0 then false
           else true end
   where id = p_variant_id;

  insert into public.food_stock_log (variant_id, delta, new_qty, reason, actor_id, portal_id, note)
  values (p_variant_id, p_new_qty - v_old, p_new_qty, p_reason, app.jwt_sub(), app.current_portal_id(), p_note);
  perform app.log_action('kitchen.set_stock', 'menu_variants', p_variant_id::text,
                         jsonb_build_object('available_qty', v_old),
                         jsonb_build_object('available_qty', p_new_qty, 'reason', p_reason));
end $$;
revoke all on function public.set_food_stock(uuid, int, text, text) from public;
grant execute on function public.set_food_stock(uuid, int, text, text) to authenticated, service_role;

create or replace function public.set_variant_available(
  p_variant_id uuid, p_available boolean, p_reason text default null
) returns void language plpgsql security definer set search_path = public, app as $$
begin
  if not (app.has_perm('kitchen.manage_availability') or app.has_perm('availability.update')
          or app.has_perm('menu.update')) then
    raise exception 'forbidden' using errcode = 'insufficient_privilege';
  end if;
  update public.menu_variants set is_available = p_available where id = p_variant_id;
  if not found then raise exception 'variant_not_found' using errcode = 'no_data_found'; end if;
  perform app.log_action('kitchen.availability', 'menu_variants', p_variant_id::text,
                         null, jsonb_build_object('is_available', p_available, 'reason', p_reason));
end $$;
revoke all on function public.set_variant_available(uuid, boolean, text) from public;
grant execute on function public.set_variant_available(uuid, boolean, text) to authenticated, service_role;

create or replace function public.record_waste(
  p_variant_id uuid, p_qty int, p_reason text, p_note text default null
) returns void language plpgsql security definer set search_path = public, app as $$
declare v_old int; v_new int;
begin
  if not app.has_perm('kitchen.record_waste') then
    raise exception 'forbidden' using errcode = 'insufficient_privilege';
  end if;
  if coalesce(p_qty, 0) <= 0 then raise exception 'bad_qty' using errcode = 'check_violation'; end if;
  select available_qty into v_old from public.menu_variants where id = p_variant_id;
  if not found then raise exception 'variant_not_found' using errcode = 'no_data_found'; end if;
  v_new := greatest(0, v_old - p_qty);
  update public.menu_variants set available_qty = v_new, track_availability = true where id = p_variant_id;
  insert into public.food_stock_log (variant_id, delta, new_qty, reason, actor_id, portal_id, note)
  values (p_variant_id, -p_qty, v_new, 'waste', app.jwt_sub(), app.current_portal_id(),
          coalesce(nullif(trim(p_reason), ''), p_note));
  perform app.log_action('kitchen.waste', 'menu_variants', p_variant_id::text,
                         jsonb_build_object('available_qty', v_old),
                         jsonb_build_object('available_qty', v_new, 'wasted', p_qty, 'reason', p_reason));
end $$;
revoke all on function public.record_waste(uuid, int, text, text) from public;
grant execute on function public.record_waste(uuid, int, text, text) to authenticated, service_role;

do $$ begin execute 'alter publication supabase_realtime add table public.menu_variants';
exception when duplicate_object then null; end $$;
do $$ begin
  execute 'create trigger audit after insert or update or delete on public.food_stock_log for each row execute function app.audit_row()';
exception when duplicate_object then null; end $$;

-- ── place_order: carry customer instructions through to the kitchen ───────
drop function if exists public.place_order(text, text, text, integer, jsonb, int, text);

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
      (order_id, menu_item_id, variant_id, name_snapshot, variant_name_snapshot,
       unit_price_cents, qty, line_total_cents, modifiers, customer_note)
    values
      (v_order_id, v_item_id, v_variant_id,
       v_item_name || case when v_variant_name is not null and v_variant_name <> 'Regular' then ' · ' || v_variant_name else '' end,
       v_variant_name, v_price, v_qty, v_lt, coalesce(v_line->'modifiers','[]'::jsonb),
       nullif(left(coalesce(v_line->>'note', ''), 500), ''));

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
    customer_note = nullif(left(coalesce(p_customer_note, ''), 500), ''),
    status = 'in_kitchen', updated_at = now() where id = v_order_id;

  insert into public.outbox (topic, payload) values ('order.placed', jsonb_build_object(
    'order_id', v_order_id, 'order_number', v_no, 'total_cents', v_total, 'table_label', p_table_label));

  return query select v_order_id, v_no, v_sub, v_disc, v_tax, v_total;
end $$;
revoke all on function public.place_order(text, text, text, integer, jsonb, int, text, text) from public;
grant execute on function public.place_order(text, text, text, integer, jsonb, int, text, text) to authenticated, service_role, anon;
