-- ============================================================================
-- Tenant delta 0060 — Food availability automation: scoped priority
-- allocation, explicit ON/OFF setting, order-time enforcement.
--
-- Extends the existing engine (0052 recipe-driven availability, 0054
-- priority waterfall) — it does not add a second one. product_availability
-- stays the single authoritative result every surface reads (Kitchen, Menu,
-- POS, customer storefront), and its realtime publication (0052) stays the
-- notification path.
--
-- What changes:
--   1. business_settings.priority_allocation_enabled — the explicit
--      Priority Allocation ON/OFF switch. Before this, allocation silently
--      switched on whenever any product_priority row existed. Existing
--      tenants keep today's behavior (ON iff they had priorities).
--   2. The waterfall is SCOPED: a stock/recipe/priority change reallocates
--      only the connected group of products that share ingredients with
--      what changed (transitive closure over recipe_components), not every
--      product in the restaurant. Products outside that group can't be
--      affected — they share no ingredient with it.
--   3. place_order() lines are checked against the authoritative allocated
--      quantity (BEFORE INSERT on order_lines). Raw-stock checks alone let a
--      lower-priority product consume stock the waterfall had allocated to a
--      higher-priority one. Existing orders/KOTs are never touched.
--   4. Kitchen actions that work through the same chain instead of a
--      separate manual count: record_dish_waste() deducts the dish's recipe
--      ingredients (so availability recalculates), set_item_available() is
--      the manual take-off-sale switch for items without variants.
-- ============================================================================

-- ── 1. Setting ────────────────────────────────────────────────────────────
alter table public.business_settings
  add column if not exists priority_allocation_enabled boolean not null default false;
update public.business_settings
   set priority_allocation_enabled = true
 where id and exists (select 1 from public.product_priority);

create or replace function app.priority_allocation_on() returns boolean
language sql stable security definer set search_path = public, app as $$
  select coalesce((select priority_allocation_enabled from public.business_settings where id), false)
$$;

-- ── 2. Dependency scope ───────────────────────────────────────────────────
-- Every ingredient connected to the seed set: an ingredient pulls in every
-- product whose recipe uses it, and each such product pulls in all of its
-- own ingredients, repeated to a fixed point. A seed ingredient used only
-- by a REQUIRED modifier also pulls in that item's recipe ingredients, so
-- the item is reallocated against the right pool.
create or replace function app.availability_scope(p_ingredient_ids uuid[])
returns uuid[] language sql stable security definer set search_path = public, app as $$
  with recursive seed(id) as (
    select unnest(p_ingredient_ids)
    union
    select rc.inventory_item_id
      from public.modifier_recipe_components mrc
      join public.modifier_options mo on mo.id = mrc.modifier_option_id
      join public.modifier_groups mg on mg.id = mo.group_id and mg.min_select >= 1
      join public.recipe_components rc on rc.menu_item_id = mg.menu_item_id
     where mrc.inventory_item_id = any(p_ingredient_ids)
  ),
  ing(id) as (
    select id from seed
    union
    select rc2.inventory_item_id
      from ing
      join public.recipe_components rc1 on rc1.inventory_item_id = ing.id
      join public.recipe_components rc2 on rc2.menu_item_id = rc1.menu_item_id
  )
  select coalesce(array_agg(distinct id), '{}'::uuid[]) from ing
$$;

-- Every ingredient an item's availability depends on (its recipes plus its
-- required modifier groups' options).
create or replace function app.item_ingredients(p_menu_item_id uuid)
returns uuid[] language sql stable security definer set search_path = public, app as $$
  select coalesce(array_agg(distinct x), '{}'::uuid[]) from (
    select inventory_item_id as x from public.recipe_components where menu_item_id = p_menu_item_id
    union
    select mrc.inventory_item_id
      from public.modifier_recipe_components mrc
      join public.modifier_options mo on mo.id = mrc.modifier_option_id
      join public.modifier_groups mg on mg.id = mo.group_id
     where mg.menu_item_id = p_menu_item_id and mg.min_select >= 1
  ) s
$$;

-- ── 3. Scoped waterfall ───────────────────────────────────────────────────
-- Same greedy allocation as 0054 (critical → high → medium → low by rank,
-- then unprioritized alphabetically; each product's claim is deducted from
-- the pool before the next is computed), restricted to the connected
-- scope. p_ingredient_ids null = the whole restaurant (manual recalculation
-- and turning the setting on).
drop function if exists app.recalc_priority_allocation(text, text);
create or replace function app.recalc_priority_allocation(
  p_trigger_type text default 'priority_reallocation',
  p_trigger_reference text default null,
  p_ingredient_ids uuid[] default null
) returns void language plpgsql security definer set search_path = public, app as $fn$
declare
  v_scope uuid[];
  v_prod record;
  v_r record;
  v_effective_variant uuid;
  v_has_variant_recipe boolean;
begin
  if not app.priority_allocation_on() then
    return;
  end if;

  -- One waterfall at a time per restaurant: runs share priority_stock_pool
  -- rows, so concurrent orders reallocating overlapping scopes serialize
  -- here instead of interleaving (or deadlocking) on the pool.
  perform pg_advisory_xact_lock(hashtext('app.recalc_priority_allocation'));

  if p_ingredient_ids is null then
    select coalesce(array_agg(id), '{}'::uuid[]) into v_scope from public.inventory_items;
  else
    v_scope := app.availability_scope(p_ingredient_ids);
  end if;
  if cardinality(v_scope) = 0 then
    return;
  end if;

  delete from public.priority_stock_pool where inventory_item_id = any(v_scope);
  insert into public.priority_stock_pool (inventory_item_id, remaining)
    select id, greatest(stock_qty, 0) from public.inventory_items where id = any(v_scope);

  for v_prod in
    select x.menu_item_id, x.variant_id,
           case coalesce(pp.priority_level, 'unprioritized')
             when 'critical' then 0 when 'high' then 1 when 'medium' then 2 when 'low' then 3
             else 4
           end as level_rank,
           coalesce(pp.priority_rank, 999999) as rank_in_level,
           mi.name as item_name
      from (
        select distinct menu_item_id, variant_id from public.recipe_components
         where inventory_item_id = any(v_scope)
        union
        select distinct mg.menu_item_id, null::uuid
          from public.modifier_groups mg
         where mg.min_select >= 1
           and (p_ingredient_ids is null or exists (
                 select 1 from public.modifier_options mo
                   join public.modifier_recipe_components mrc on mrc.modifier_option_id = mo.id
                  where mo.group_id = mg.id and mrc.inventory_item_id = any(v_scope)))
      ) x
      join public.menu_items mi on mi.id = x.menu_item_id
      left join public.product_priority pp on pp.menu_item_id = x.menu_item_id
     order by level_rank, rank_in_level, mi.name, x.variant_id nulls first
  loop
    select * into v_r from app.compute_product_capacity(v_prod.menu_item_id, v_prod.variant_id, true);
    perform app.apply_product_availability_result(
      v_prod.menu_item_id, v_prod.variant_id, v_r.tracked, v_r.status, v_r.producible_qty,
      v_r.bottleneck_inventory_item_id, v_r.reason, p_trigger_type, p_trigger_reference, 'system'
    );

    if v_r.tracked and coalesce(v_r.producible_qty, 0) > 0 then
      if v_prod.variant_id is not null then
        select exists(select 1 from public.recipe_components
                       where menu_item_id = v_prod.menu_item_id and variant_id = v_prod.variant_id)
          into v_has_variant_recipe;
        v_effective_variant := case when v_has_variant_recipe then v_prod.variant_id else null end;
      else
        v_effective_variant := null;
      end if;

      update public.priority_stock_pool ps
         set remaining = ps.remaining - (v_r.producible_qty * rc.qty_per_unit)
        from public.recipe_components rc
       where rc.menu_item_id = v_prod.menu_item_id
         and rc.variant_id is not distinct from v_effective_variant
         and ps.inventory_item_id = rc.inventory_item_id;
    end if;
  end loop;
end;
$fn$;

-- ── 4. Triggers: ON → scoped waterfall, OFF → the targeted per-product
-- engine exactly as before ────────────────────────────────────────────────
create or replace function app.on_inventory_stock_change() returns trigger
language plpgsql security definer set search_path = public, app as $$
declare v_type text;
begin
  if new.stock_qty is distinct from old.stock_qty then
    v_type := case when new.stock_qty > old.stock_qty then 'inventory_restock' else 'inventory_consumption' end;
    if app.priority_allocation_on() then
      perform app.recalc_priority_allocation(v_type, new.id::text, array[new.id]);
    else
      perform app.recalc_products_for_ingredient(new.id, v_type, null);
    end if;
  end if;
  return new;
end;
$$;

create or replace function app.on_recipe_components_change() returns trigger
language plpgsql security definer set search_path = public, app as $$
declare v_item uuid; v_variant uuid; v_ings uuid[];
begin
  if tg_op = 'DELETE' then
    v_item := old.menu_item_id; v_variant := old.variant_id;
  else
    v_item := new.menu_item_id; v_variant := new.variant_id;
  end if;
  -- Per-product pass first: it also clears the row of a product whose last
  -- recipe line was just removed (it's no longer tracked at all).
  perform app.recalc_product_availability(v_item, v_variant, 'recipe_change', null);
  if v_variant is not null then
    perform app.recalc_product_availability(v_item, null, 'recipe_change', null);
  end if;
  if app.priority_allocation_on() then
    v_ings := app.item_ingredients(v_item);
    if tg_op in ('DELETE', 'UPDATE') then v_ings := v_ings || old.inventory_item_id; end if;
    if tg_op in ('INSERT', 'UPDATE') then v_ings := v_ings || new.inventory_item_id; end if;
    perform app.recalc_priority_allocation('recipe_change', v_item::text, v_ings);
  end if;
  return coalesce(new, old);
end;
$$;

create or replace function app.on_modifier_recipe_components_change() returns trigger
language plpgsql security definer set search_path = public, app as $$
declare v_option uuid; v_item uuid; r record;
begin
  v_option := coalesce(new.modifier_option_id, old.modifier_option_id);
  select mg.menu_item_id into v_item
    from public.modifier_options mo join public.modifier_groups mg on mg.id = mo.group_id
   where mo.id = v_option;
  if v_item is not null then
    if app.priority_allocation_on() then
      perform app.recalc_priority_allocation('recipe_change', v_item::text,
        app.item_ingredients(v_item) || coalesce(new.inventory_item_id, old.inventory_item_id));
    else
      for r in select variant_id from public.product_availability where menu_item_id = v_item loop
        perform app.recalc_product_availability(v_item, r.variant_id, 'recipe_change', null);
      end loop;
      perform app.recalc_product_availability(v_item, null, 'recipe_change', null);
    end if;
  end if;
  return coalesce(new, old);
end;
$$;

create or replace function app.on_modifier_option_availability_change() returns trigger
language plpgsql security definer set search_path = public, app as $$
declare v_item uuid; r record;
begin
  if new.is_available is distinct from old.is_available then
    select mg.menu_item_id into v_item from public.modifier_groups mg where mg.id = new.group_id;
    if v_item is not null then
      if app.priority_allocation_on() then
        perform app.recalc_priority_allocation('recipe_change', v_item::text, app.item_ingredients(v_item));
      else
        for r in select variant_id from public.product_availability where menu_item_id = v_item loop
          perform app.recalc_product_availability(v_item, r.variant_id, 'recipe_change', null);
        end loop;
        perform app.recalc_product_availability(v_item, null, 'recipe_change', null);
      end if;
    end if;
  end if;
  return new;
end;
$$;

-- ── 5. Priority management: reallocate only the changed product's group ───
create or replace function public.set_product_priority(p_menu_item_id uuid, p_priority_level text)
returns void language plpgsql security definer set search_path = public, app as $fn$
declare v_next_rank int; v_cur_level text;
begin
  if not (app.has_perm('availability.update') or app.can_write()) then
    raise exception 'forbidden' using errcode = 'insufficient_privilege';
  end if;
  if p_priority_level not in ('critical', 'high', 'medium', 'low') then
    raise exception 'bad_priority_level' using errcode = 'check_violation';
  end if;
  select priority_level into v_cur_level from public.product_priority where menu_item_id = p_menu_item_id;
  if v_cur_level is null then
    select coalesce(max(priority_rank), 0) + 1 into v_next_rank from public.product_priority where priority_level = p_priority_level;
    insert into public.product_priority (menu_item_id, priority_level, priority_rank)
    values (p_menu_item_id, p_priority_level, v_next_rank);
  elsif v_cur_level <> p_priority_level then
    select coalesce(max(priority_rank), 0) + 1 into v_next_rank from public.product_priority where priority_level = p_priority_level;
    update public.product_priority set priority_level = p_priority_level, priority_rank = v_next_rank, updated_at = now()
     where menu_item_id = p_menu_item_id;
  end if;
  perform app.recalc_priority_allocation('priority_change', p_menu_item_id::text, app.item_ingredients(p_menu_item_id));
end;
$fn$;

create or replace function public.remove_product_priority(p_menu_item_id uuid)
returns void language plpgsql security definer set search_path = public, app as $fn$
begin
  if not (app.has_perm('availability.update') or app.can_write()) then
    raise exception 'forbidden' using errcode = 'insufficient_privilege';
  end if;
  delete from public.product_priority where menu_item_id = p_menu_item_id;
  perform app.recalc_priority_allocation('priority_change', p_menu_item_id::text, app.item_ingredients(p_menu_item_id));
end;
$fn$;

create or replace function public.reorder_product_priority(p_priority_level text, p_ordered_menu_item_ids uuid[])
returns void language plpgsql security definer set search_path = public, app as $fn$
declare v_id uuid; v_rank int := 1; v_ings uuid[] := '{}';
begin
  if not (app.has_perm('availability.update') or app.can_write()) then
    raise exception 'forbidden' using errcode = 'insufficient_privilege';
  end if;
  if p_priority_level not in ('critical', 'high', 'medium', 'low') then
    raise exception 'bad_priority_level' using errcode = 'check_violation';
  end if;
  update public.product_priority set priority_rank = priority_rank + 1000000
   where priority_level = p_priority_level and menu_item_id = any(p_ordered_menu_item_ids);
  foreach v_id in array p_ordered_menu_item_ids loop
    update public.product_priority set priority_rank = v_rank, updated_at = now()
     where menu_item_id = v_id and priority_level = p_priority_level;
    v_rank := v_rank + 1;
    v_ings := v_ings || app.item_ingredients(v_id);
  end loop;
  perform app.recalc_priority_allocation('priority_change', null, v_ings);
end;
$fn$;

-- The ON/OFF switch. availability.update is the same key that already
-- governs priority configuration.
create or replace function public.set_priority_allocation(p_enabled boolean)
returns void language plpgsql security definer set search_path = public, app as $fn$
begin
  if not (app.has_perm('availability.update') or app.can_write()) then
    raise exception 'forbidden' using errcode = 'insufficient_privilege';
  end if;
  update public.business_settings set priority_allocation_enabled = coalesce(p_enabled, false) where id;
  perform app.log_action(case when p_enabled then 'availability.allocation_on' else 'availability.allocation_off' end,
                         'business_settings', 'priority_allocation_enabled');
  if p_enabled then
    perform app.recalc_priority_allocation('priority_change', 'allocation_on', null);
  else
    -- Back to every product's independent capacity.
    perform public.recalculate_all_product_availability();
  end if;
end;
$fn$;
revoke all on function public.set_priority_allocation(boolean) from public;
grant execute on function public.set_priority_allocation(boolean) to authenticated, service_role;

-- ── 6. Order-time enforcement ─────────────────────────────────────────────
-- The authoritative allocated quantity, not just raw stock, bounds what a
-- new order line may take. Runs before the line's own stock deduction (the
-- line is inserted first in place_order()), so it sees availability as it
-- was before this line; the row lock serializes two orders racing for the
-- last portions. A variant without its own recipe uses the item's base row.
create or replace function app.guard_order_line_availability() returns trigger
language plpgsql security definer set search_path = public, app as $fn$
declare v_status text; v_qty numeric; v_found boolean := false; v_name text;
begin
  if new.menu_item_id is null then
    return new;
  end if;
  if new.variant_id is not null then
    select status, producible_qty into v_status, v_qty from public.product_availability
     where menu_item_id = new.menu_item_id and variant_id = new.variant_id
     for update;
    v_found := found;
  end if;
  if not v_found then
    select status, producible_qty into v_status, v_qty from public.product_availability
     where menu_item_id = new.menu_item_id and variant_id is null
     for update;
    v_found := found;
  end if;
  if v_found and (v_status = 'unavailable' or (v_qty is not null and v_qty < new.qty)) then
    v_name := coalesce(new.name_snapshot, new.menu_item_id::text);
    raise exception 'item_unavailable: % (% available)', v_name, coalesce(floor(v_qty)::int, 0)
      using errcode = 'check_violation';
  end if;
  return new;
end;
$fn$;
drop trigger if exists guard_order_line_availability on public.order_lines;
create trigger guard_order_line_availability before insert on public.order_lines
  for each row execute function app.guard_order_line_availability();

-- ── 7. Kitchen actions through the same chain ─────────────────────────────
-- Waste N portions of a dish: deducts its recipe's ingredients (variant
-- recipe if it has one, else the base recipe — same rule as place_order()),
-- which fires the stock trigger and recalculates availability. Never drives
-- stock below zero.
create or replace function public.record_dish_waste(
  p_menu_item_id uuid, p_variant_id uuid, p_qty int, p_reason text
) returns void language plpgsql security definer set search_path = public, app as $fn$
declare v_has_variant_recipe boolean; v_comp record; v_need numeric; v_cost numeric; v_name text;
begin
  if not app.has_perm('kitchen.record_waste') then
    raise exception 'forbidden' using errcode = 'insufficient_privilege';
  end if;
  if coalesce(p_qty, 0) <= 0 then raise exception 'bad_qty' using errcode = 'check_violation'; end if;
  if coalesce(trim(p_reason), '') = '' then raise exception 'reason_required' using errcode = 'check_violation'; end if;
  select name into v_name from public.menu_items where id = p_menu_item_id;
  if not found then raise exception 'item_not_found' using errcode = 'no_data_found'; end if;
  select exists(select 1 from public.recipe_components
                 where menu_item_id = p_menu_item_id and variant_id = p_variant_id)
    into v_has_variant_recipe;
  for v_comp in
    select inventory_item_id, qty_per_unit from public.recipe_components
     where menu_item_id = p_menu_item_id
       and variant_id is not distinct from (case when v_has_variant_recipe then p_variant_id else null end)
  loop
    v_need := v_comp.qty_per_unit * p_qty;
    select cost_cents_per_base_unit into v_cost from public.inventory_items where id = v_comp.inventory_item_id;
    update public.inventory_items set stock_qty = greatest(stock_qty - v_need, 0)
     where id = v_comp.inventory_item_id;
    insert into public.stock_ledger (inventory_item_id, delta_qty, reason, note, unit_cost_cents_base)
    values (v_comp.inventory_item_id, -v_need, 'spoilage',
            v_name || ' ×' || p_qty || ': ' || trim(p_reason), v_cost);
  end loop;
  perform app.log_action('kitchen.dish_waste', 'menu_items', p_menu_item_id::text, null,
                         jsonb_build_object('variant_id', p_variant_id, 'qty', p_qty, 'reason', p_reason));
end;
$fn$;
revoke all on function public.record_dish_waste(uuid, uuid, int, text) from public;
grant execute on function public.record_dish_waste(uuid, uuid, int, text) to authenticated, service_role;

-- Manual take-off-sale switch for an item (set_variant_available covers
-- variants). A kill switch only — it never sets a quantity; the computed
-- availability keeps updating underneath and both combine at read time.
create or replace function public.set_item_available(p_menu_item_id uuid, p_available boolean)
returns void language plpgsql security definer set search_path = public, app as $fn$
begin
  if not (app.has_perm('kitchen.manage_availability') or app.has_perm('availability.update')
          or app.has_perm('menu.update')) then
    raise exception 'forbidden' using errcode = 'insufficient_privilege';
  end if;
  update public.menu_items set is_available = p_available where id = p_menu_item_id;
  if not found then raise exception 'item_not_found' using errcode = 'no_data_found'; end if;
  perform app.log_action('kitchen.item_availability', 'menu_items', p_menu_item_id::text, null,
                         jsonb_build_object('is_available', p_available));
end;
$fn$;
revoke all on function public.set_item_available(uuid, boolean) from public;
grant execute on function public.set_item_available(uuid, boolean) to authenticated, service_role;

-- Kitchen needs the names that go with the availability rows.
drop policy if exists kitchen_read_items on public.menu_items;
create policy kitchen_read_items on public.menu_items for select using (app.has_perm('kitchen.view'));
drop policy if exists kitchen_read_variants on public.menu_variants;
create policy kitchen_read_variants on public.menu_variants for select using (app.has_perm('kitchen.view'));
drop policy if exists kitchen_read_availability on public.product_availability;
create policy kitchen_read_availability on public.product_availability for select using (app.has_perm('kitchen.view'));
