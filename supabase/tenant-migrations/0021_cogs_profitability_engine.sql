-- 0021: COGS & Profitability engine (recipe/inventory/costing spec §22-31,
-- §49). Reuses rather than duplicates: inventory_items, recipe_components,
-- order_lines.recipe_cost_cents, stock_ledger, orders.discount_cents/
-- refunded_cents, deals/deal_components, and app.day_sales's own definition
-- of "a sale" (P3/0020, P4, P7, P8) all already existed — this adds the ONE
-- calculation layer on top of them (order/period/item/deal profitability +
-- menu engineering), an expenses table so period_profitability can reach
-- real Net Profit, and a cost-basis snapshot on every stock_ledger row so
-- Actual COGS can be read straight off the ledger instead of reconstructing
-- historical stock balances.

-- ── stock_ledger: cost basis at the moment of each movement ────────────────
alter table public.stock_ledger add column if not exists unit_cost_cents_base numeric(14,4);

-- adjust_stock / record_ingredient_waste / submit_stock_count: snapshot the
-- item's cost at the moment of the move (same bodies as 0020, plus the
-- snapshot).
create or replace function public.adjust_stock(
  p_inventory_item_id uuid, p_delta numeric, p_reason text, p_note text default null
) returns numeric
language plpgsql security definer set search_path = public, app as $$
declare v_new numeric; v_cost numeric;
begin
  if not (app.has_perm('stock.adjust') or app.has_perm('inventory.manage')
          or (app.can_write() and app.current_member_role() is not null)) then
    raise exception 'forbidden' using errcode = 'insufficient_privilege';
  end if;
  select cost_cents_per_base_unit into v_cost from public.inventory_items where id = p_inventory_item_id;
  update public.inventory_items set stock_qty = stock_qty + p_delta
   where id = p_inventory_item_id returning stock_qty into v_new;
  if not found then raise exception 'inventory_item_not_found' using errcode = 'foreign_key_violation'; end if;
  if v_new < 0 then raise exception 'would_go_negative' using errcode = 'check_violation'; end if;
  insert into public.stock_ledger (inventory_item_id, delta_qty, reason, note, unit_cost_cents_base)
  values (p_inventory_item_id, p_delta, coalesce(nullif(p_reason,''),'adjustment')::app.stock_reason, p_note, v_cost);
  return v_new;
end $$;
revoke all on function public.adjust_stock(uuid, numeric, text, text) from public;
grant execute on function public.adjust_stock(uuid, numeric, text, text) to authenticated, service_role;

create or replace function public.record_ingredient_waste(
  p_inventory_item_id uuid, p_qty numeric, p_note text
) returns numeric
language plpgsql security definer set search_path = public, app as $$
declare v_new numeric; v_cost numeric;
begin
  if not (app.has_perm('inventory.manage_waste') or app.has_perm('stock.adjust') or app.can_write()) then
    raise exception 'forbidden' using errcode = 'insufficient_privilege';
  end if;
  if coalesce(p_qty, 0) <= 0 then raise exception 'bad_qty' using errcode = 'check_violation'; end if;
  if coalesce(trim(p_note), '') = '' then raise exception 'reason_required' using errcode = 'check_violation'; end if;
  select cost_cents_per_base_unit into v_cost from public.inventory_items where id = p_inventory_item_id;
  update public.inventory_items set stock_qty = stock_qty - p_qty
   where id = p_inventory_item_id and stock_qty >= p_qty
   returning stock_qty into v_new;
  if not found then raise exception 'insufficient_stock: %', p_inventory_item_id using errcode = 'check_violation'; end if;
  insert into public.stock_ledger (inventory_item_id, delta_qty, reason, note, unit_cost_cents_base)
  values (p_inventory_item_id, -p_qty, 'spoilage', p_note, v_cost);
  return v_new;
end $$;
revoke all on function public.record_ingredient_waste(uuid, numeric, text) from public;
grant execute on function public.record_ingredient_waste(uuid, numeric, text) to authenticated, service_role;

create or replace function public.submit_stock_count(
  p_inventory_item_id uuid, p_counted_qty numeric, p_note text default null
) returns jsonb
language plpgsql security definer set search_path = public, app as $$
declare v_before numeric; v_delta numeric; v_cost numeric;
begin
  if not (app.has_perm('stock.count') or app.has_perm('stock.adjust') or app.can_write()) then
    raise exception 'forbidden' using errcode = 'insufficient_privilege';
  end if;
  if p_counted_qty < 0 then raise exception 'bad_qty' using errcode = 'check_violation'; end if;
  select stock_qty, cost_cents_per_base_unit into v_before, v_cost from public.inventory_items where id = p_inventory_item_id;
  if not found then raise exception 'inventory_item_not_found' using errcode = 'foreign_key_violation'; end if;
  v_delta := p_counted_qty - v_before;
  update public.inventory_items set stock_qty = p_counted_qty where id = p_inventory_item_id;
  insert into public.stock_ledger (inventory_item_id, delta_qty, reason, note, unit_cost_cents_base)
  values (p_inventory_item_id, v_delta, 'stock_take', coalesce(nullif(trim(p_note), ''), 'stock count'), v_cost);
  return jsonb_build_object('before', v_before, 'counted', p_counted_qty, 'variance', v_delta);
end $$;
revoke all on function public.submit_stock_count(uuid, numeric, text) from public;
grant execute on function public.submit_stock_count(uuid, numeric, text) to authenticated, service_role;

-- receive_purchase_order / receive_purchase_order_line: snapshot the actual
-- receipt cost (not the resulting weighted average) as the ledger's cost
-- basis for that purchase.
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
      insert into public.stock_ledger (inventory_item_id, delta_qty, reason, note, unit_cost_cents_base)
      values (r.inventory_item_id, v_recv_base, 'restock', 'PO receipt', v_receipt_cost_per_base);
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
    insert into public.stock_ledger (inventory_item_id, delta_qty, reason, note, unit_cost_cents_base)
    values (r.inventory_item_id, v_recv_base, 'restock', 'PO partial receipt', v_receipt_cost_per_base);
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

-- place_order: same body as 0020, plus a cost-basis snapshot on each of the
-- three order_deduction ledger inserts (deal-component recipe explosion,
-- plain-item base recipe, modifier-linked consumption).
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
          insert into public.stock_ledger (inventory_item_id, delta_qty, reason, order_id, unit_cost_cents_base)
          values (v_comp.inventory_item_id, -v_need, 'order_deduction', v_order_id, v_cost_per_base);
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
        insert into public.stock_ledger (inventory_item_id, delta_qty, reason, order_id, unit_cost_cents_base)
        values (v_comp.inventory_item_id, -v_need, 'order_deduction', v_order_id, v_cost_per_base);
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
        insert into public.stock_ledger (inventory_item_id, delta_qty, reason, order_id, unit_cost_cents_base)
        values (v_comp.inventory_item_id, -v_need, 'order_deduction', v_order_id, v_cost_per_base);
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

-- ── Operating expenses (spec §28-29 — Prime Cost / Net Profit inputs) ──────
create table if not exists public.expenses (
  id           uuid primary key default gen_random_uuid(),
  category     text not null,
  description  text,
  amount_cents int not null check (amount_cents > 0),
  expense_date date not null default current_date,
  recorded_by  uuid,
  created_at   timestamptz not null default now()
);
create index if not exists expenses_date_idx on public.expenses(expense_date desc);
alter table public.expenses enable row level security;
drop policy if exists staff_read on public.expenses;
drop policy if exists staff_insert on public.expenses;
drop policy if exists staff_update on public.expenses;
drop policy if exists staff_delete on public.expenses;
create policy staff_read on public.expenses for select using (app.has_perm('finance.view') or app.is_staff());
create policy staff_insert on public.expenses for insert with check (app.has_perm('finance.create_expense') or app.can_write());
create policy staff_update on public.expenses for update using (app.has_perm('finance.update_expense') or app.can_write()) with check (app.has_perm('finance.update_expense') or app.can_write());
create policy staff_delete on public.expenses for delete using (app.has_perm('finance.delete_expense') or app.can_write());
drop trigger if exists audit on public.expenses;
create trigger audit after insert or update or delete on public.expenses for each row execute function app.audit_row();

-- ── COGS & Profitability engine ─────────────────────────────────────────────
create or replace function public.order_profitability(p_order_id uuid)
returns table (
  order_id uuid, order_number bigint, status text,
  gross_sales_cents int, discount_cents int, refunded_cents int, tax_cents int,
  net_sales_cents int, cogs_cents int, cogs_lines_total int, cogs_lines_missing int,
  food_cost_pct numeric, contribution_cents int, contribution_margin_pct numeric
)
language plpgsql stable security definer set search_path = public, app as $fn$
begin
  if not (app.has_perm('finance.view_profit') or app.has_perm('finance.view_cogs') or app.has_perm('inventory.view_cost')) then
    raise exception 'forbidden' using errcode = 'insufficient_privilege';
  end if;
  return query
    with base as (
      select o.id, o.order_number, o.status::text as status,
             o.subtotal_cents as gross_sales_cents, o.discount_cents,
             coalesce(o.refunded_cents,0) as refunded_cents, o.tax_cents,
             (o.subtotal_cents - o.discount_cents - coalesce(o.refunded_cents,0)) as net_sales_cents
        from public.orders o where o.id = p_order_id
    ),
    agg as (
      select coalesce(sum(ol.recipe_cost_cents),0)::int as cogs_cents,
             count(*)::int as lines_total,
             count(*) filter (where ol.recipe_cost_cents is null)::int as lines_missing
        from public.order_lines ol where ol.order_id = p_order_id
    )
    select base.id, base.order_number, base.status,
           base.gross_sales_cents, base.discount_cents, base.refunded_cents, base.tax_cents,
           base.net_sales_cents, agg.cogs_cents, agg.lines_total, agg.lines_missing,
           case when base.net_sales_cents > 0 then round(agg.cogs_cents::numeric / base.net_sales_cents * 1000) / 10 else null end,
           (base.net_sales_cents - agg.cogs_cents),
           case when base.net_sales_cents > 0 then round((base.net_sales_cents - agg.cogs_cents)::numeric / base.net_sales_cents * 1000) / 10 else null end
      from base, agg;
end $fn$;
revoke all on function public.order_profitability(uuid) from public;
grant execute on function public.order_profitability(uuid) to authenticated, service_role;

create or replace function public.period_profitability(p_from timestamptz, p_to timestamptz)
returns table (
  from_ts timestamptz, to_ts timestamptz,
  orders_count int, gross_sales_cents int, discount_cents int, refunded_cents int,
  net_sales_cents int, avg_order_cents int,
  theoretical_cogs_cents int, cogs_lines_total int, cogs_lines_missing int,
  gross_profit_cents int, gross_margin_pct numeric, food_cost_pct numeric,
  consumption_ledger_cents int, waste_cents int, net_adjustment_cents int,
  actual_cogs_cents int, cogs_variance_cents int,
  expenses_cents int, net_profit_cents int, net_profit_margin_pct numeric
)
language plpgsql stable security definer set search_path = public, app as $fn$
begin
  if not (app.has_perm('finance.view_profit') or app.has_perm('finance.view_cogs') or app.has_perm('inventory.view_cost')) then
    raise exception 'forbidden' using errcode = 'insufficient_privilege';
  end if;
  return query
    with sales as (
      select o.id, o.subtotal_cents, o.discount_cents, coalesce(o.refunded_cents,0) as refunded_cents
        from public.orders o
       where o.status in ('served','paid')
         and coalesce(o.paid_at, o.created_at) >= p_from and coalesce(o.paid_at, o.created_at) < p_to
    ),
    sales_agg as (
      select count(*)::int as orders_count,
             coalesce(sum(sales.subtotal_cents),0)::int as gross_sales_cents,
             coalesce(sum(sales.discount_cents),0)::int as discount_cents,
             coalesce(sum(sales.refunded_cents),0)::int as refunded_cents,
             coalesce(sum(sales.subtotal_cents - sales.discount_cents - sales.refunded_cents),0)::int as net_sales_cents
        from sales
    ),
    cogs_agg as (
      select coalesce(sum(l.recipe_cost_cents),0)::int as cogs_cents,
             count(*)::int as lines_total,
             count(*) filter (where l.recipe_cost_cents is null)::int as lines_missing
        from public.order_lines l join sales s on s.id = l.order_id
    ),
    ledger_agg as (
      select
        coalesce(sum(abs(delta_qty * unit_cost_cents_base)) filter (where reason = 'order_deduction'), 0)::int as consumption_cents,
        coalesce(sum(abs(delta_qty * unit_cost_cents_base)) filter (where reason = 'spoilage'), 0)::int as waste_cents,
        coalesce(sum(delta_qty * unit_cost_cents_base) filter (where reason in ('adjustment','stock_take')), 0)::int as net_adjustment_cents
        from public.stock_ledger
       where created_at >= p_from and created_at < p_to and unit_cost_cents_base is not null
    ),
    exp_agg as (
      -- expense_date is a plain date (no time-of-day); the upper bound is
      -- inclusive so an expense dated "today" is still counted when p_to is
      -- "now" — a strict "<" against a date-truncated timestamptz would
      -- otherwise drop every expense recorded earlier today.
      select coalesce(sum(amount_cents),0)::int as expenses_cents
        from public.expenses
       where expense_date >= p_from::date and expense_date <= p_to::date
    )
    select
      p_from, p_to,
      sales_agg.orders_count, sales_agg.gross_sales_cents, sales_agg.discount_cents, sales_agg.refunded_cents,
      sales_agg.net_sales_cents,
      case when sales_agg.orders_count > 0 then round(sales_agg.net_sales_cents::numeric / sales_agg.orders_count)::int else 0 end,
      cogs_agg.cogs_cents, cogs_agg.lines_total, cogs_agg.lines_missing,
      (sales_agg.net_sales_cents - cogs_agg.cogs_cents),
      case when sales_agg.net_sales_cents > 0 then round((sales_agg.net_sales_cents - cogs_agg.cogs_cents)::numeric / sales_agg.net_sales_cents * 1000) / 10 else null end,
      case when sales_agg.net_sales_cents > 0 then round(cogs_agg.cogs_cents::numeric / sales_agg.net_sales_cents * 1000) / 10 else null end,
      ledger_agg.consumption_cents, ledger_agg.waste_cents, ledger_agg.net_adjustment_cents,
      (ledger_agg.consumption_cents + ledger_agg.waste_cents - ledger_agg.net_adjustment_cents),
      (ledger_agg.consumption_cents + ledger_agg.waste_cents - ledger_agg.net_adjustment_cents - cogs_agg.cogs_cents),
      exp_agg.expenses_cents,
      (sales_agg.net_sales_cents - cogs_agg.cogs_cents - exp_agg.expenses_cents),
      case when sales_agg.net_sales_cents > 0 then round((sales_agg.net_sales_cents - cogs_agg.cogs_cents - exp_agg.expenses_cents)::numeric / sales_agg.net_sales_cents * 1000) / 10 else null end
      from sales_agg, cogs_agg, ledger_agg, exp_agg;
end $fn$;
revoke all on function public.period_profitability(timestamptz, timestamptz) from public;
grant execute on function public.period_profitability(timestamptz, timestamptz) to authenticated, service_role;

create or replace function public.item_profitability(p_from timestamptz, p_to timestamptz)
returns table (
  menu_item_id uuid, variant_id uuid, name text,
  qty_sold int, revenue_cents int, cogs_cents int, cogs_known boolean,
  contribution_cents int, contribution_margin_pct numeric, food_cost_pct numeric
)
language plpgsql stable security definer set search_path = public, app as $fn$
begin
  if not (app.has_perm('finance.view_profit') or app.has_perm('finance.view_cogs') or app.has_perm('inventory.view_cost')) then
    raise exception 'forbidden' using errcode = 'insufficient_privilege';
  end if;
  return query
    select
      l.menu_item_id, l.variant_id, max(l.name_snapshot) as name,
      sum(l.qty)::int as qty_sold, sum(l.line_total_cents)::int as revenue_cents,
      coalesce(sum(l.recipe_cost_cents),0)::int as cogs_cents,
      bool_and(l.recipe_cost_cents is not null) as cogs_known,
      (sum(l.line_total_cents) - coalesce(sum(l.recipe_cost_cents),0))::int as contribution_cents,
      case when sum(l.line_total_cents) > 0
        then round((sum(l.line_total_cents) - coalesce(sum(l.recipe_cost_cents),0))::numeric / sum(l.line_total_cents) * 1000) / 10
        else null end as contribution_margin_pct,
      case when sum(l.line_total_cents) > 0
        then round(coalesce(sum(l.recipe_cost_cents),0)::numeric / sum(l.line_total_cents) * 1000) / 10
        else null end as food_cost_pct
      from public.order_lines l
      join public.orders o on o.id = l.order_id
     where l.deal_id is null and l.menu_item_id is not null
       and o.status in ('served','paid')
       and coalesce(o.paid_at, o.created_at) >= p_from and coalesce(o.paid_at, o.created_at) < p_to
     group by l.menu_item_id, l.variant_id
     order by revenue_cents desc;
end $fn$;
revoke all on function public.item_profitability(timestamptz, timestamptz) from public;
grant execute on function public.item_profitability(timestamptz, timestamptz) to authenticated, service_role;

create or replace function public.deal_profitability(p_from timestamptz, p_to timestamptz)
returns table (
  deal_id uuid, name text, qty_sold int, revenue_cents int, cogs_cents int, cogs_known boolean,
  contribution_cents int, contribution_margin_pct numeric, food_cost_pct numeric,
  list_value_cents int, customer_saving_cents int
)
language plpgsql stable security definer set search_path = public, app as $fn$
begin
  if not (app.has_perm('finance.view_profit') or app.has_perm('finance.view_cogs') or app.has_perm('inventory.view_cost')) then
    raise exception 'forbidden' using errcode = 'insufficient_privilege';
  end if;
  return query
    with header as (
      select l.order_id, l.deal_id, l.name_snapshot as name, l.qty, l.line_total_cents
        from public.order_lines l
        join public.orders o on o.id = l.order_id
       where l.deal_id is not null and l.menu_item_id is null
         and o.status in ('served','paid')
         and coalesce(o.paid_at, o.created_at) >= p_from and coalesce(o.paid_at, o.created_at) < p_to
    ),
    comp as (
      select ol.order_id, ol.deal_id,
             coalesce(sum(ol.recipe_cost_cents),0)::int as cogs_cents,
             bool_and(ol.recipe_cost_cents is not null) as cogs_known
        from public.order_lines ol
       where ol.deal_id is not null and ol.menu_item_id is not null
       group by ol.order_id, ol.deal_id
    ),
    list_price as (
      select dc.deal_id, sum(dc.qty * coalesce(v.price_cents, mi.price_cents, 0))::int as list_value_cents
        from public.deal_components dc
        join public.menu_items mi on mi.id = dc.menu_item_id
        left join public.menu_variants v on v.id = dc.variant_id
       group by dc.deal_id
    )
    select
      h.deal_id, max(h.name) as name, sum(h.qty)::int as qty_sold, sum(h.line_total_cents)::int as revenue_cents,
      coalesce(sum(c.cogs_cents),0)::int as cogs_cents,
      coalesce(bool_and(c.cogs_known), false) as cogs_known,
      (sum(h.line_total_cents) - coalesce(sum(c.cogs_cents),0))::int as contribution_cents,
      case when sum(h.line_total_cents) > 0
        then round((sum(h.line_total_cents) - coalesce(sum(c.cogs_cents),0))::numeric / sum(h.line_total_cents) * 1000) / 10
        else null end as contribution_margin_pct,
      case when sum(h.line_total_cents) > 0
        then round(coalesce(sum(c.cogs_cents),0)::numeric / sum(h.line_total_cents) * 1000) / 10
        else null end as food_cost_pct,
      max(lp.list_value_cents) as list_value_cents,
      case when max(lp.list_value_cents) is not null
        then (max(lp.list_value_cents) * sum(h.qty) - sum(h.line_total_cents))::int
        else null end as customer_saving_cents
      from header h
      left join comp c on c.order_id = h.order_id and c.deal_id = h.deal_id
      left join list_price lp on lp.deal_id = h.deal_id
     group by h.deal_id
     order by revenue_cents desc;
end $fn$;
revoke all on function public.deal_profitability(timestamptz, timestamptz) from public;
grant execute on function public.deal_profitability(timestamptz, timestamptz) to authenticated, service_role;

create or replace function public.menu_engineering(p_from timestamptz, p_to timestamptz)
returns table (
  menu_item_id uuid, variant_id uuid, name text, qty_sold int, revenue_cents int,
  contribution_per_unit_cents int, total_contribution_cents int, quadrant text
)
language plpgsql stable security definer set search_path = public, app as $fn$
declare v_avg_qty numeric; v_avg_contrib numeric;
begin
  if not (app.has_perm('finance.view_profit') or app.has_perm('finance.view_cogs') or app.has_perm('inventory.view_cost')) then
    raise exception 'forbidden' using errcode = 'insufficient_privilege';
  end if;

  select avg(ip.qty_sold), avg(case when ip.qty_sold > 0 then ip.contribution_cents::numeric / ip.qty_sold else 0 end)
    into v_avg_qty, v_avg_contrib
    from public.item_profitability(p_from, p_to) ip;

  return query
    select
      ip.menu_item_id, ip.variant_id, ip.name, ip.qty_sold, ip.revenue_cents,
      case when ip.qty_sold > 0 then round(ip.contribution_cents::numeric / ip.qty_sold)::int else 0 end,
      ip.contribution_cents,
      case
        when ip.qty_sold >= coalesce(v_avg_qty,0) and (case when ip.qty_sold > 0 then ip.contribution_cents::numeric / ip.qty_sold else 0 end) >= coalesce(v_avg_contrib,0)
          then 'Star (high sales, high contribution)'
        when ip.qty_sold >= coalesce(v_avg_qty,0)
          then 'Plowhorse (high sales, low contribution)'
        when (case when ip.qty_sold > 0 then ip.contribution_cents::numeric / ip.qty_sold else 0 end) >= coalesce(v_avg_contrib,0)
          then 'Puzzle (low sales, high contribution)'
        else 'Dog (low sales, low contribution)'
      end
      from public.item_profitability(p_from, p_to) ip
     order by ip.revenue_cents desc;
end $fn$;
revoke all on function public.menu_engineering(timestamptz, timestamptz) from public;
grant execute on function public.menu_engineering(timestamptz, timestamptz) to authenticated, service_role;
