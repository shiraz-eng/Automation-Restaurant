-- ============================================================================
-- Tenant delta 0054 — Recipe/Menu Inventory Consumption Priority
--
-- Layers a priority-ordered SHARED-INGREDIENT ALLOCATION on top of the
-- existing recipe-driven availability engine (0052/0053) — it does not
-- duplicate or replace it. The exact same computation this engine already
-- performs per product (floor(stock/qty_per_unit), bottleneck tracking,
-- required-modifier-group viability) is extracted into ONE shared helper,
-- app.compute_product_capacity(), which BOTH the plain per-product engine
-- (app.recalc_product_availability, unchanged behavior, reads live
-- inventory_items.stock_qty) and the new priority waterfall
-- (app.recalc_priority_allocation, reads a working "remaining stock"
-- pool) now call — never two copies of the same math. Likewise, the
-- upsert-into-product_availability-plus-audit-log step is extracted into
-- app.apply_product_availability_result(), used by both paths.
--
-- product_priority: which menu items are "key" enough to have an explicit
-- priority, and their level (critical/high/medium/low) + rank (position
-- within that level, drag-and-drop reorderable). Absence from this table
-- means "no explicit priority" — such a product is still included in the
-- waterfall (as lowest priority, alphabetical) whenever ANY priority
-- exists tenant-wide, so it correctly sees the true leftover stock after
-- prioritized products have taken their share.
--
-- priority_stock_pool: scratch working state for ONE waterfall run only —
-- reseeded from live inventory_items.stock_qty at the start of every
-- app.recalc_priority_allocation() call, decremented as each product in
-- priority order claims its share. Never read outside that function.
--
-- When NO product_priority rows exist (the default, and the case for
-- every tenant before this feature is used), app.recalc_priority_
-- allocation() is a no-op and every existing trigger keeps calling the
-- same targeted per-ingredient recalc it always has — zero behavior
-- change until an Owner actually sets a priority.
--
-- Audit: priority CONFIGURATION changes (add/remove/reorder/re-level) are
-- captured for free by the same generic app.audit_row() trigger every
-- other management table already uses. Priority-DRIVEN allocation changes
-- (a product's computed availability changed because of the waterfall)
-- are captured by the SAME availability_audit_log this engine already
-- writes to, tagged trigger_type='priority_reallocation' — the existing
-- Availability History page already renders whatever trigger_type comes
-- back, so no new audit table or report page is needed.
-- ============================================================================

create table public.product_priority (
  id             uuid primary key default gen_random_uuid(),
  menu_item_id   uuid not null unique references public.menu_items(id) on delete cascade,
  priority_level text not null default 'medium' check (priority_level in ('critical', 'high', 'medium', 'low')),
  priority_rank  int not null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create unique index product_priority_level_rank_uq on public.product_priority(priority_level, priority_rank);
alter table public.product_priority enable row level security;
create policy staff_read on public.product_priority for select using (app.has_perm('availability.view') or app.is_staff());
-- No direct write policy for any role — writes only through
-- set_product_priority/remove_product_priority/reorder_product_priority
-- below (SECURITY DEFINER), same immutable-from-client convention
-- product_availability/availability_audit_log already use.
create trigger audit_product_priority after insert or update or delete on public.product_priority
  for each row execute function app.audit_row();

create table public.priority_stock_pool (
  inventory_item_id uuid primary key references public.inventory_items(id) on delete cascade,
  remaining         numeric(14,3) not null default 0
);
alter table public.priority_stock_pool enable row level security;
create policy staff_read on public.priority_stock_pool for select using (app.has_perm('availability.view') or app.is_staff());

alter publication supabase_realtime add table public.product_priority;

-- ── Shared calculation core (extracted from app.recalc_product_availability
-- verbatim — same math, same recipe-resolution rule, same required-
-- modifier-group check — parameterized only on WHICH stock figure to read
-- for each ingredient: live inventory_items.stock_qty (p_use_priority_pool
-- = false, the plain per-product engine's existing behavior, unchanged) or
-- priority_stock_pool.remaining (p_use_priority_pool = true, the waterfall,
-- which has already deducted every higher-priority product's own claim by
-- the time a lower-priority product is computed). ────────────────────────
create or replace function app.compute_product_capacity(
  p_menu_item_id uuid, p_variant_id uuid, p_use_priority_pool boolean default false
) returns table (
  tracked boolean, status text, producible_qty numeric,
  bottleneck_inventory_item_id uuid, reason text
) language plpgsql stable security definer set search_path = public, app as $fn$
declare
  v_effective_variant uuid;
  v_has_variant_recipe boolean;
  v_comp record;
  v_capacity numeric;
  v_min_capacity numeric;
  v_bottleneck uuid;
  v_bottleneck_name text;
  v_bottleneck_low boolean;
  v_has_recipe boolean := false;
  v_tracked boolean := false;
  v_producible numeric;
  v_status text;
  v_reason text;
  v_req_group record;
  v_group_viable boolean;
  v_opt record;
  v_opt_cap numeric;
  v_opt_row record;
  v_cap numeric;
  v_needs_modifier_override boolean := false;
  v_modifier_reason text;
begin
  if p_variant_id is not null then
    select exists(
      select 1 from public.recipe_components where menu_item_id = p_menu_item_id and variant_id = p_variant_id
    ) into v_has_variant_recipe;
    v_effective_variant := case when v_has_variant_recipe then p_variant_id else null end;
  else
    v_effective_variant := null;
  end if;

  v_min_capacity := null;
  for v_comp in
    select rc.inventory_item_id, rc.qty_per_unit, i.min_threshold, i.name,
           case when p_use_priority_pool then coalesce(ps.remaining, i.stock_qty) else i.stock_qty end as eff_stock
      from public.recipe_components rc
      join public.inventory_items i on i.id = rc.inventory_item_id
      left join public.priority_stock_pool ps on p_use_priority_pool and ps.inventory_item_id = rc.inventory_item_id
     where rc.menu_item_id = p_menu_item_id
       and rc.variant_id is not distinct from v_effective_variant
  loop
    v_has_recipe := true;
    v_capacity := floor(greatest(v_comp.eff_stock, 0) / v_comp.qty_per_unit);
    if v_min_capacity is null or v_capacity < v_min_capacity then
      v_min_capacity := v_capacity;
      v_bottleneck := v_comp.inventory_item_id;
      v_bottleneck_name := v_comp.name;
      v_bottleneck_low := v_comp.eff_stock <= v_comp.min_threshold;
    end if;
  end loop;

  if v_has_recipe then
    v_tracked := true;
    v_producible := v_min_capacity;
    if v_producible <= 0 then
      v_status := 'unavailable';
      v_reason := v_bottleneck_name || ' unavailable';
    elsif v_bottleneck_low then
      v_status := 'low_stock';
      v_reason := v_bottleneck_name || ' approaching reorder level';
    else
      v_status := 'available';
      v_reason := null;
    end if;
  else
    v_producible := null;
    v_status := 'available';
    v_reason := null;
  end if;

  for v_req_group in
    select id, name from public.modifier_groups
     where menu_item_id = p_menu_item_id and min_select >= 1
  loop
    v_tracked := true;
    v_group_viable := false;
    for v_opt in
      select id from public.modifier_options where group_id = v_req_group.id and is_available
    loop
      v_opt_cap := null;
      for v_opt_row in
        select mrc.qty_base,
               case when p_use_priority_pool then coalesce(ps.remaining, i.stock_qty) else i.stock_qty end as eff_stock
          from public.modifier_recipe_components mrc
          join public.inventory_items i on i.id = mrc.inventory_item_id
          left join public.priority_stock_pool ps on p_use_priority_pool and ps.inventory_item_id = mrc.inventory_item_id
         where mrc.modifier_option_id = v_opt.id
      loop
        v_cap := floor(greatest(v_opt_row.eff_stock, 0) / v_opt_row.qty_base);
        if v_opt_cap is null or v_cap < v_opt_cap then v_opt_cap := v_cap; end if;
      end loop;
      if v_opt_cap is null or v_opt_cap > 0 then
        v_group_viable := true;
        exit;
      end if;
    end loop;
    if not v_group_viable then
      v_needs_modifier_override := true;
      v_modifier_reason := 'No available options for ' || v_req_group.name;
      exit;
    end if;
  end loop;

  if v_needs_modifier_override and v_status is distinct from 'unavailable' then
    v_status := 'unavailable';
    v_reason := v_modifier_reason;
    v_producible := 0;
  end if;

  return query select v_tracked, v_status, v_producible, v_bottleneck, v_reason;
end;
$fn$;

-- ── Shared write core (extracted from app.recalc_product_availability
-- verbatim) — upserts product_availability and, only on a real change,
-- appends to availability_audit_log + app.log_action. Used by both the
-- plain engine and the priority waterfall so every consumer (Menu
-- Management, Customer Menu, POS, KOT, portals, AI, Availability History)
-- keeps reading the ONE same table regardless of which path computed it.
create or replace function app.apply_product_availability_result(
  p_menu_item_id uuid, p_variant_id uuid, p_tracked boolean, p_status text, p_producible numeric,
  p_bottleneck uuid, p_reason text, p_trigger_type text, p_trigger_reference text, p_actor text
) returns void language plpgsql security definer set search_path = public, app as $fn$
declare v_prev record;
begin
  if not p_tracked then
    delete from public.product_availability
     where menu_item_id = p_menu_item_id and variant_id is not distinct from p_variant_id;
    return;
  end if;

  select status, producible_qty into v_prev
    from public.product_availability
   where menu_item_id = p_menu_item_id and variant_id is not distinct from p_variant_id;

  insert into public.product_availability
    (menu_item_id, variant_id, status, producible_qty, bottleneck_inventory_item_id, reason, updated_at)
  values
    (p_menu_item_id, p_variant_id, p_status, p_producible, p_bottleneck, p_reason, now())
  on conflict (menu_item_id, variant_id) do update set
    status = excluded.status,
    producible_qty = excluded.producible_qty,
    bottleneck_inventory_item_id = excluded.bottleneck_inventory_item_id,
    reason = excluded.reason,
    updated_at = now();

  if v_prev is null or v_prev.status is distinct from p_status or v_prev.producible_qty is distinct from p_producible then
    insert into public.availability_audit_log
      (menu_item_id, variant_id, previous_status, new_status, previous_producible_qty, new_producible_qty,
       bottleneck_inventory_item_id, reason, trigger_type, trigger_reference, actor)
    values
      (p_menu_item_id, p_variant_id, v_prev.status, p_status, v_prev.producible_qty, p_producible,
       p_bottleneck, p_reason, p_trigger_type, p_trigger_reference, p_actor);
    perform app.log_action('availability.changed', 'menu_items', p_menu_item_id::text, null,
      jsonb_build_object('variant_id', p_variant_id, 'status', p_status, 'producible_qty', p_producible, 'reason', p_reason));
  end if;
end;
$fn$;

-- app.recalc_product_availability() is now a thin wrapper over the two
-- shared helpers above — identical external signature and behavior to
-- before this migration; every existing caller (triggers, RPCs) needs no
-- change.
create or replace function app.recalc_product_availability(
  p_menu_item_id uuid,
  p_variant_id uuid,
  p_trigger_type text default 'manual_recalculation',
  p_trigger_reference text default null,
  p_actor text default 'system'
) returns void
language plpgsql security definer set search_path = public, app as $$
declare v_r record;
begin
  select * into v_r from app.compute_product_capacity(p_menu_item_id, p_variant_id, false);
  perform app.apply_product_availability_result(
    p_menu_item_id, p_variant_id, v_r.tracked, v_r.status, v_r.producible_qty,
    v_r.bottleneck_inventory_item_id, v_r.reason, p_trigger_type, p_trigger_reference, p_actor
  );
end;
$$;

-- ── The priority waterfall ───────────────────────────────────────────────
-- No-op when no priority is configured (the ordinary per-product/per-
-- ingredient targeted engine stays authoritative in that case — see the
-- trigger changes below). Otherwise: reseed the working stock pool from
-- live inventory, then walk every tracked (menu_item, variant) pair in
-- priority order — critical, then high, then medium, then low, each
-- ordered by its rank within that level; anything with no explicit
-- priority comes last, alphabetically, so it still sees the true leftover
-- after prioritized products claim theirs. Each product's capacity is
-- computed against whatever remains in the pool, then its own claim
-- (producible_qty × qty_per_unit, per ingredient) is deducted before the
-- next, lower-priority product is computed — a single-pass greedy
-- allocation, the direct, auditable meaning of "higher priority gets
-- shared capacity first".
create or replace function app.recalc_priority_allocation(
  p_trigger_type text default 'priority_reallocation', p_trigger_reference text default null
) returns void language plpgsql security definer set search_path = public, app as $fn$
declare
  v_has_priorities boolean;
  v_prod record;
  v_r record;
  v_effective_variant uuid;
  v_has_variant_recipe boolean;
begin
  select exists(select 1 from public.product_priority) into v_has_priorities;
  if not v_has_priorities then
    return;
  end if;

  delete from public.priority_stock_pool where true;
  insert into public.priority_stock_pool (inventory_item_id, remaining)
    select id, greatest(stock_qty, 0) from public.inventory_items;

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
        union
        select distinct mg.menu_item_id, null::uuid from public.modifier_groups mg where mg.min_select >= 1
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
        select exists(select 1 from public.recipe_components where menu_item_id = v_prod.menu_item_id and variant_id = v_prod.variant_id)
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

-- ── Priority management RPCs ─────────────────────────────────────────────
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
    -- Changing level moves it to the end of the new level's list — same
    -- "append" convention a freshly-added item gets.
    select coalesce(max(priority_rank), 0) + 1 into v_next_rank from public.product_priority where priority_level = p_priority_level;
    update public.product_priority set priority_level = p_priority_level, priority_rank = v_next_rank, updated_at = now()
     where menu_item_id = p_menu_item_id;
  end if;

  perform app.recalc_priority_allocation('priority_change', p_menu_item_id::text);
end;
$fn$;
revoke all on function public.set_product_priority(uuid, text) from public;
grant execute on function public.set_product_priority(uuid, text) to authenticated, service_role;

create or replace function public.remove_product_priority(p_menu_item_id uuid)
returns void language plpgsql security definer set search_path = public, app as $fn$
begin
  if not (app.has_perm('availability.update') or app.can_write()) then
    raise exception 'forbidden' using errcode = 'insufficient_privilege';
  end if;
  delete from public.product_priority where menu_item_id = p_menu_item_id;
  if not exists (select 1 from public.product_priority) then
    -- That was the last priority — fall all the way back to the plain
    -- independent-per-product engine for every tracked product.
    perform public.recalculate_all_product_availability();
  else
    perform app.recalc_priority_allocation('priority_change', p_menu_item_id::text);
  end if;
end;
$fn$;
revoke all on function public.remove_product_priority(uuid) from public;
grant execute on function public.remove_product_priority(uuid) to authenticated, service_role;

create or replace function public.reorder_product_priority(p_priority_level text, p_ordered_menu_item_ids uuid[])
returns void language plpgsql security definer set search_path = public, app as $fn$
declare v_id uuid; v_rank int := 1;
begin
  if not (app.has_perm('availability.update') or app.can_write()) then
    raise exception 'forbidden' using errcode = 'insufficient_privilege';
  end if;
  if p_priority_level not in ('critical', 'high', 'medium', 'low') then
    raise exception 'bad_priority_level' using errcode = 'check_violation';
  end if;

  -- Two-phase to dodge the (priority_level, priority_rank) unique index
  -- while ranks are mid-shuffle.
  update public.product_priority set priority_rank = priority_rank + 1000000
   where priority_level = p_priority_level and menu_item_id = any(p_ordered_menu_item_ids);

  foreach v_id in array p_ordered_menu_item_ids loop
    update public.product_priority set priority_rank = v_rank, updated_at = now()
     where menu_item_id = v_id and priority_level = p_priority_level;
    v_rank := v_rank + 1;
  end loop;

  perform app.recalc_priority_allocation('priority_change', null);
end;
$fn$;
revoke all on function public.reorder_product_priority(text, uuid[]) from public;
grant execute on function public.reorder_product_priority(text, uuid[]) to authenticated, service_role;

-- ── Trigger integration: when priorities exist, a stock/recipe/modifier
-- change recomputes via the GLOBAL waterfall (simplest way to guarantee
-- every prioritized AND unprioritized product's numbers stay mutually
-- consistent); otherwise, exactly the same targeted per-ingredient recalc
-- as before this migration. ─────────────────────────────────────────────
create or replace function app.on_inventory_stock_change() returns trigger
language plpgsql security definer set search_path = public, app as $$
begin
  if new.stock_qty is distinct from old.stock_qty then
    if exists(select 1 from public.product_priority) then
      perform app.recalc_priority_allocation(
        case when new.stock_qty > old.stock_qty then 'inventory_restock' else 'inventory_consumption' end,
        null
      );
    else
      perform app.recalc_products_for_ingredient(
        new.id,
        case when new.stock_qty > old.stock_qty then 'inventory_restock' else 'inventory_consumption' end,
        null
      );
    end if;
  end if;
  return new;
end;
$$;

create or replace function app.on_recipe_components_change() returns trigger
language plpgsql security definer set search_path = public, app as $$
declare v_item uuid; v_variant uuid;
begin
  if tg_op = 'DELETE' then
    v_item := old.menu_item_id; v_variant := old.variant_id;
  else
    v_item := new.menu_item_id; v_variant := new.variant_id;
  end if;
  if exists(select 1 from public.product_priority) then
    perform app.recalc_priority_allocation('recipe_change', null);
  else
    perform app.recalc_product_availability(v_item, v_variant, 'recipe_change', null);
    if v_variant is not null then
      perform app.recalc_product_availability(v_item, null, 'recipe_change', null);
    end if;
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
    if exists(select 1 from public.product_priority) then
      perform app.recalc_priority_allocation('recipe_change', null);
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
      if exists(select 1 from public.product_priority) then
        perform app.recalc_priority_allocation('recipe_change', null);
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

-- Bulk backfill also runs the waterfall at the end (safe no-op when no
-- priority exists) — so a full manual recalculation stays correct either way.
create or replace function public.recalculate_all_product_availability()
returns void
language plpgsql security definer set search_path = public, app as $$
declare r record;
begin
  if not (app.has_perm('availability.update') or app.is_staff()) then
    raise exception 'forbidden' using errcode = 'insufficient_privilege';
  end if;
  for r in select distinct menu_item_id, variant_id from public.recipe_components loop
    perform app.recalc_product_availability(r.menu_item_id, r.variant_id, 'manual_recalculation', null);
  end loop;
  for r in
    select distinct mg.menu_item_id
      from public.modifier_groups mg
     where mg.min_select >= 1
       and not exists (select 1 from public.recipe_components rc where rc.menu_item_id = mg.menu_item_id)
  loop
    perform app.recalc_product_availability(r.menu_item_id, null, 'manual_recalculation', null);
  end loop;
  perform app.recalc_priority_allocation('manual_recalculation', null);
end;
$$;
