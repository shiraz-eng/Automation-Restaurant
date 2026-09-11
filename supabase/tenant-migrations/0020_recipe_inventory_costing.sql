-- 0020: a real recipe-based inventory/costing engine, replacing the "Burger
-- = 10" flat-counter model. Purchasing, ingredient stock, recipes (now
-- variant- and modifier-aware), consumption, waste, adjustments, and stock
-- counts all feed the same stock_ledger, with a single weighted-average
-- costing method used everywhere ingredient cost is read — including a
-- per-order-line cost snapshot that never changes after the fact, so a
-- later recipe or cost change can't retroactively alter a past order's
-- food cost. Also adds kitchen-to-counter order routing.
--
-- Reuses rather than duplicates: inventory_items, recipe_components,
-- stock_ledger, purchase_orders/purchase_order_lines, and adjust_stock all
-- already existed (P3) — this extends them instead of building a parallel
-- system.

-- ── inventory_items: unit conversion + weighted-average cost ──────────────
alter table public.inventory_items
  add column if not exists unit_kind text not null default 'count' check (unit_kind in ('weight', 'volume', 'count')),
  add column if not exists purchase_unit_label text,
  add column if not exists purchase_unit_to_base numeric(14,4) not null default 1 check (purchase_unit_to_base > 0),
  add column if not exists cost_cents_per_base_unit numeric(14,4) not null default 0 check (cost_cents_per_base_unit >= 0);

-- ── recipe_components: variant-specific overrides ──────────────────────────
alter table public.recipe_components
  add column if not exists variant_id uuid references public.menu_variants(id) on delete cascade;
alter table public.recipe_components drop constraint if exists recipe_components_menu_item_id_inventory_item_id_key;
alter table public.recipe_components
  add constraint recipe_components_menu_item_id_variant_id_inventory_item_id_key
  unique (menu_item_id, variant_id, inventory_item_id);

-- ── modifier-linked consumption (e.g. Extra Cheese -> +1 cheese slice) ────
create table if not exists public.modifier_recipe_components (
  id                  uuid primary key default gen_random_uuid(),
  modifier_option_id  uuid not null references public.modifier_options(id) on delete cascade,
  inventory_item_id   uuid not null references public.inventory_items(id) on delete restrict,
  qty_base            numeric(14,3) not null check (qty_base > 0),
  unique (modifier_option_id, inventory_item_id)
);
alter table public.modifier_recipe_components enable row level security;
drop policy if exists staff_read on public.modifier_recipe_components;
drop policy if exists mgr_write on public.modifier_recipe_components;
create policy staff_read on public.modifier_recipe_components for select using (app.has_perm('menu.view') or app.is_staff());
create policy mgr_write on public.modifier_recipe_components for all using (app.has_perm('menu.update') or app.can_write()) with check (app.has_perm('menu.update') or app.can_write());
drop trigger if exists audit on public.modifier_recipe_components;
create trigger audit after insert or update or delete on public.modifier_recipe_components for each row execute function app.audit_row();

-- ── order_lines: immutable per-line ingredient-cost snapshot ──────────────
alter table public.order_lines add column if not exists recipe_cost_cents int;

-- ── orders: which counter Kitchen assigned this order to ──────────────────
alter table public.orders add column if not exists pickup_counter_portal_id uuid;

-- ── permission catalog ─────────────────────────────────────────────────────
insert into public.permission_catalog (key, grp, label) values
  ('stock.count','Stock','Perform stock counts'),
  ('purchases.receive','Purchases','Receive purchase deliveries'),
  ('inventory.manage_waste','Inventory','Record ingredient waste'),
  ('inventory.manage_recipes','Inventory','Manage recipes'),
  ('inventory.view_cost','Inventory','View ingredient & recipe cost')
on conflict (key) do update set grp = excluded.grp, label = excluded.label;

-- Give the built-in Manager preset the new keys (additive — dedup via a set union).
update public.roles
   set permissions = (
     select array(select distinct unnest(
       permissions || array[
         'stock.count','purchases.receive','inventory.manage_waste',
         'inventory.manage_recipes','inventory.view_cost'
       ]
     ))
   )
 where key = 'manager' and is_system;

-- ── RPCs ────────────────────────────────────────────────────────────────────
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

-- ── place_order(): recipe explosion is now variant- and modifier-aware,
-- and snapshots ingredient cost onto each line at the moment of sale ──────
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
      select v.id, v.menu_item_id, i.name, v.name, v.price_cents, v.track_availability, (v.is_available and i.is_available)
        into v_variant_id, v_item_id, v_item_name, v_variant_name, v_price, v_track, v_avail
        from public.menu_variants v join public.menu_items i on i.id = v.menu_item_id
       where v.id = v_variant_id;
      if not found then raise exception 'variant_not_found: %', v_line->>'variant_id' using errcode = 'foreign_key_violation'; end if;
    else
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
