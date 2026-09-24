-- ============================================================================
-- Tenant delta 0065 — fair allocation inside a priority level.
--
-- 0062 split a shared ingredient between priority LEVELS by percentage, but
-- inside a level the first product (or the first SIZE of a product) took the
-- level's entire share before the next was considered. On a real menu that
-- showed e.g. Chicken Strips 6 pcs = 148 and Chicken Strips 3 pcs = 0 from
-- the same 148 packaging boxes, and Chicken Burger Double = 63 while
-- Chicken Burger Regular = 0 from the same cheese. Products with no priority
-- were also only ever given leftovers, so French Fries (no priority) showed
-- 0 despite plenty of stock.
--
-- Now:
--   * A level's share of each ingredient is split EVENLY between the
--     products (every size counts) in that level that need it; whatever a
--     product can't use goes back into the next round, same as before.
--   * A product with no priority counts as Low. Ranked Low products still
--     come first for any final leftovers.
--   * Everything else is unchanged: percentages between levels, recipe caps,
--     redistribution rounds, final priority pass, no stock reserved.
-- ============================================================================

create or replace function app.recalc_priority_allocation(
  p_trigger_type text default 'priority_reallocation',
  p_trigger_reference text default null,
  p_ingredient_ids uuid[] default null
) returns void language plpgsql security definer set search_path = public, app as $fn$
declare
  v_scope uuid[];
  v_pass int;
  v_moved numeric;
  v_p record;
  v_r record;
  v_live record;
  v_cap numeric;
  v_claim numeric;
  v_extra numeric;
  v_final numeric;
  v_status text;
  v_reason text;
begin
  if not app.priority_allocation_on() then
    return;
  end if;
  perform pg_advisory_xact_lock(hashtext('app.recalc_priority_allocation'));

  if p_ingredient_ids is null then
    select coalesce(array_agg(id), '{}'::uuid[]) into v_scope from public.inventory_items;
  else
    v_scope := app.availability_scope(p_ingredient_ids);
  end if;
  if cardinality(v_scope) = 0 then
    return;
  end if;

  -- Usable stock.
  delete from public.priority_stock_pool where inventory_item_id = any(v_scope);
  insert into public.priority_stock_pool (inventory_item_id, remaining)
    select id, greatest(stock_qty, 0) from public.inventory_items where id = any(v_scope);

  create temp table if not exists alloc_product (
    menu_item_id uuid, variant_id uuid, level text, level_rank int, rank_in_level int,
    item_name text, pct numeric not null default 0, claim numeric not null default 0
  ) on commit drop;
  -- Per (level, ingredient): the share EACH product in that level may use this round.
  create temp table if not exists alloc_share (
    level text, inventory_item_id uuid, per_product numeric, primary key (level, inventory_item_id)
  ) on commit drop;
  create temp table if not exists alloc_hungry (menu_item_id uuid, variant_id uuid, level text) on commit drop;
  truncate alloc_product;

  -- Products in scope; no priority = Low (after the ranked Low products).
  insert into alloc_product (menu_item_id, variant_id, level, level_rank, rank_in_level, item_name, pct)
  select x.menu_item_id, x.variant_id, coalesce(pp.priority_level, 'low'),
         case coalesce(pp.priority_level, 'low') when 'critical' then 0 when 'high' then 1 when 'medium' then 2 else 3 end,
         coalesce(pp.priority_rank, 999999), mi.name,
         coalesce(case when pla.is_active then pla.allocation_pct end, 0)
    from (select distinct menu_item_id, variant_id from public.recipe_components
           where inventory_item_id = any(v_scope)) x
    join public.menu_items mi on mi.id = x.menu_item_id
    left join public.product_priority pp on pp.menu_item_id = x.menu_item_id
    left join public.priority_level_allocation pla on pla.priority_level = coalesce(pp.priority_level, 'low');

  -- Percentage rounds, then redistribution rounds of whatever is left.
  for v_pass in 1..10 loop
    -- products with a percentage that can still make at least one more
    truncate alloc_hungry;
    insert into alloc_hungry (menu_item_id, variant_id, level)
    select ap.menu_item_id, ap.variant_id, ap.level
      from alloc_product ap
     where ap.pct > 0
       and (select min(floor(ps.remaining / rc.qty_per_unit))
              from public.recipe_components rc
              join public.priority_stock_pool ps on ps.inventory_item_id = rc.inventory_item_id
             where rc.menu_item_id = ap.menu_item_id
               and rc.variant_id is not distinct from ap.variant_id) > 0;
    exit when not exists (select 1 from alloc_hungry);

    truncate alloc_share;
    insert into alloc_share (level, inventory_item_id, per_product)
    with level_ing as (
      select h.level, rc.inventory_item_id, count(*) as products
        from alloc_hungry h
        join public.recipe_components rc
          on rc.menu_item_id = h.menu_item_id and rc.variant_id is not distinct from h.variant_id
       group by h.level, rc.inventory_item_id
    ),
    weighted as (
      select li.*, pla.allocation_pct as pct
        from level_ing li
        join public.priority_level_allocation pla on pla.priority_level = li.level
    ),
    totals as (
      select inventory_item_id, sum(pct) as total from weighted group by inventory_item_id
    )
    select w.level, w.inventory_item_id, ps.remaining * w.pct / t.total / w.products
      from weighted w
      join totals t on t.inventory_item_id = w.inventory_item_id
      join public.priority_stock_pool ps on ps.inventory_item_id = w.inventory_item_id
     where t.total > 0;

    v_moved := 0;
    for v_p in
      select h.menu_item_id, h.variant_id, h.level from alloc_hungry h
    loop
      select min(floor(coalesce(s.per_product, 0) / rc.qty_per_unit)) into v_cap
        from public.recipe_components rc
        left join alloc_share s on s.level = v_p.level and s.inventory_item_id = rc.inventory_item_id
       where rc.menu_item_id = v_p.menu_item_id and rc.variant_id is not distinct from v_p.variant_id;
      v_cap := greatest(coalesce(v_cap, 0), 0);
      if v_cap > 0 then
        update public.priority_stock_pool ps set remaining = ps.remaining - v_cap * rc.qty_per_unit
          from public.recipe_components rc
         where rc.menu_item_id = v_p.menu_item_id and rc.variant_id is not distinct from v_p.variant_id
           and ps.inventory_item_id = rc.inventory_item_id;
        update alloc_product set claim = claim + v_cap
         where menu_item_id = v_p.menu_item_id and variant_id is not distinct from v_p.variant_id;
        v_moved := v_moved + v_cap;
      end if;
    end loop;
    exit when v_moved = 0;
  end loop;

  -- Final priority pass for any remainder (whole-portion rounding, 0% or
  -- inactive levels, modifier-only items), then write the result.
  for v_p in
    select ap.menu_item_id, ap.variant_id, ap.level_rank, ap.rank_in_level, ap.item_name, ap.claim, true as has_recipe
      from alloc_product ap
    union all
    select mg.menu_item_id, null::uuid,
           case coalesce(pp.priority_level, 'low') when 'critical' then 0 when 'high' then 1 when 'medium' then 2 else 3 end,
           coalesce(pp.priority_rank, 999999), mi.name, 0, false
      from public.modifier_groups mg
      join public.menu_items mi on mi.id = mg.menu_item_id
      left join public.product_priority pp on pp.menu_item_id = mg.menu_item_id
     where mg.min_select >= 1
       and not exists (select 1 from alloc_product ap where ap.menu_item_id = mg.menu_item_id)
       and (p_ingredient_ids is null or exists (
             select 1 from public.modifier_options mo
               join public.modifier_recipe_components mrc on mrc.modifier_option_id = mo.id
              where mo.group_id = mg.id and mrc.inventory_item_id = any(v_scope)))
     group by mg.menu_item_id, pp.priority_level, pp.priority_rank, mi.name
     order by 3, 4, 5, 2 nulls first
  loop
    select * into v_live from app.compute_product_capacity(v_p.menu_item_id, v_p.variant_id, false);

    if not v_p.has_recipe then
      perform app.apply_product_availability_result(
        v_p.menu_item_id, v_p.variant_id, v_live.tracked, v_live.status, v_live.producible_qty,
        v_live.bottleneck_inventory_item_id, v_live.reason, p_trigger_type, p_trigger_reference, 'system');
      continue;
    end if;

    select * into v_r from app.compute_product_capacity(v_p.menu_item_id, v_p.variant_id, true);
    v_extra := greatest(coalesce(v_r.producible_qty, 0), 0);
    if v_extra > 0 then
      update public.priority_stock_pool ps set remaining = ps.remaining - v_extra * rc.qty_per_unit
        from public.recipe_components rc
       where rc.menu_item_id = v_p.menu_item_id and rc.variant_id is not distinct from v_p.variant_id
         and ps.inventory_item_id = rc.inventory_item_id;
    end if;

    v_claim := coalesce(v_p.claim, 0);
    v_final := least(v_claim + v_extra, greatest(coalesce(v_live.producible_qty, 0), 0));

    if v_live.status = 'unavailable' then
      v_final := 0;
      v_status := 'unavailable';
      v_reason := v_live.reason;
    elsif v_final <= 0 then
      v_final := 0;
      v_status := 'unavailable';
      v_reason := 'Allocated to higher-priority items';
    else
      v_status := case when v_live.status = 'low_stock' then 'low_stock' else 'available' end;
      v_reason := case when v_live.status = 'low_stock' then v_live.reason end;
    end if;

    perform app.apply_product_availability_result(
      v_p.menu_item_id, v_p.variant_id, true, v_status, v_final,
      v_live.bottleneck_inventory_item_id, v_reason, p_trigger_type, p_trigger_reference, 'system');
  end loop;
end;
$fn$;

-- Recalculate everything once with the fair rule (no-op when allocation is off).
select app.recalc_priority_allocation('manual_recalculation', 'fair_allocation', null);
