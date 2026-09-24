-- ============================================================================
-- Tenant delta 0062 — Priority-level percentage allocation.
--
-- Replaces the pure "higher priority takes everything first" waterfall of
-- 0054/0060 with a percentage split between the four existing priority
-- levels (product_priority.priority_level). Nothing new is modelled per
-- product: products keep their level and rank; the restaurant configures one
-- percentage (and an active flag) per level, validated to total exactly 100.
--
-- Calculation order (per connected group of products sharing ingredients —
-- the same scoped closure 0060 introduced):
--   1. Usable stock = live inventory_items.stock_qty (never below zero).
--   2. Each shared ingredient's capacity is split between the ACTIVE levels
--      that have at least one product needing it, in proportion to their
--      percentages (a level with no product on that ingredient doesn't hold
--      a share of it — its percentage goes to the others).
--   3. Within a level, products take from that level's share in rank order,
--      each limited by its full recipe (every ingredient), so no product is
--      ever allocated beyond what its recipe can actually produce.
--   4. Redistribution: whatever a level couldn't use (a product bottlenecked
--      on another ingredient, or nothing left to make) is split again, by the
--      same percentages, among the levels whose products can still make more.
--      Repeats until nothing more moves (bounded).
--   5. Final pass: any remainder the percentages couldn't place (rounding to
--      whole portions, 0% or inactive levels, unprioritized products) goes
--      by priority order — critical first, unprioritized last — so capacity
--      is never lost.
--   6. Each product's total is capped by its independent recipe capacity and
--      written through the same app.apply_product_availability_result() into
--      product_availability — the one table every surface reads.
--
-- Percentages allocate PRODUCTION CAPACITY only: no stock is reserved, moved
-- or consumed here. priority_stock_pool is the same scratch pool 0054 uses,
-- reseeded from live stock on every run. Orders still consume inventory
-- through place_order(), and 0060's order-line check still enforces the
-- allocated quantity.
-- ============================================================================

create table if not exists public.priority_level_allocation (
  priority_level text primary key check (priority_level in ('critical', 'high', 'medium', 'low')),
  allocation_pct numeric(5,2) not null check (allocation_pct >= 0 and allocation_pct <= 100),
  is_active      boolean not null default true,
  updated_at     timestamptz not null default now()
);
insert into public.priority_level_allocation (priority_level, allocation_pct, is_active) values
  ('critical', 40, true), ('high', 30, true), ('medium', 20, true), ('low', 10, true)
on conflict (priority_level) do nothing;
alter table public.priority_level_allocation enable row level security;
drop policy if exists staff_read on public.priority_level_allocation;
create policy staff_read on public.priority_level_allocation for select
  using (app.has_perm('availability.view') or app.has_perm('availability.update') or app.is_staff());
-- No write policy: changes only through set_priority_level_allocation().
drop trigger if exists audit on public.priority_level_allocation;
create trigger audit after insert or update or delete on public.priority_level_allocation
  for each row execute function app.audit_row();
do $$
begin
  if not exists (select 1 from pg_publication_tables
                  where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'priority_level_allocation') then
    alter publication supabase_realtime add table public.priority_level_allocation;
  end if;
end $$;

-- Save all four levels at once. Server-side validation: exactly the four
-- levels, each a number 0–100, total exactly 100. availability.update is
-- the same key that already governs priorities.
create or replace function public.set_priority_level_allocation(p_config jsonb)
returns void language plpgsql security definer set search_path = public, app as $fn$
declare v_total numeric := 0; v_e jsonb; v_levels text[] := '{}'; v_pct numeric;
begin
  if not (app.has_perm('availability.update') or app.can_write()) then
    raise exception 'forbidden' using errcode = 'insufficient_privilege';
  end if;
  if jsonb_typeof(p_config) is distinct from 'array' or jsonb_array_length(p_config) <> 4 then
    raise exception 'bad_config: provide all four priority levels' using errcode = 'check_violation';
  end if;
  for v_e in select * from jsonb_array_elements(p_config) loop
    if coalesce(v_e->>'priority_level', '') not in ('critical', 'high', 'medium', 'low')
       or (v_e->>'priority_level') = any(v_levels) then
      raise exception 'bad_config: each of critical, high, medium, low exactly once' using errcode = 'check_violation';
    end if;
    if coalesce(v_e->>'allocation_pct', '') !~ '^\d{1,3}(\.\d{1,2})?$' then
      raise exception 'bad_percentage: % must be a number from 0 to 100', v_e->>'priority_level' using errcode = 'check_violation';
    end if;
    v_pct := (v_e->>'allocation_pct')::numeric;
    if v_pct < 0 or v_pct > 100 then
      raise exception 'bad_percentage: % must be a number from 0 to 100', v_e->>'priority_level' using errcode = 'check_violation';
    end if;
    v_levels := v_levels || (v_e->>'priority_level');
    v_total := v_total + v_pct;
  end loop;
  if v_total <> 100 then
    raise exception 'bad_total: percentages add up to % percent, they must total exactly 100 percent', v_total
      using errcode = 'check_violation';
  end if;

  update public.priority_level_allocation pla
     set allocation_pct = (e->>'allocation_pct')::numeric,
         is_active = coalesce((e->>'is_active')::boolean, true),
         updated_at = now()
    from jsonb_array_elements(p_config) e
   where pla.priority_level = e->>'priority_level';

  perform app.log_action('availability.level_allocation', 'priority_level_allocation', null, null, p_config);
  perform app.recalc_priority_allocation('priority_change', 'level_percentages', null);
end;
$fn$;
revoke all on function public.set_priority_level_allocation(jsonb) from public;
grant execute on function public.set_priority_level_allocation(jsonb) to authenticated, service_role;

-- ── The allocation run ────────────────────────────────────────────────────
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

  -- 1. Usable stock.
  delete from public.priority_stock_pool where inventory_item_id = any(v_scope);
  insert into public.priority_stock_pool (inventory_item_id, remaining)
    select id, greatest(stock_qty, 0) from public.inventory_items where id = any(v_scope);

  -- Products in scope with their level, rank and effective percentage.
  create temp table if not exists alloc_product (
    menu_item_id uuid, variant_id uuid, level text, level_rank int, rank_in_level int,
    item_name text, pct numeric not null default 0, claim numeric not null default 0
  ) on commit drop;
  create temp table if not exists alloc_level_pool (
    level text, inventory_item_id uuid, remaining numeric, primary key (level, inventory_item_id)
  ) on commit drop;
  truncate alloc_product;

  insert into alloc_product (menu_item_id, variant_id, level, level_rank, rank_in_level, item_name, pct)
  select x.menu_item_id, x.variant_id, pp.priority_level,
         case pp.priority_level when 'critical' then 0 when 'high' then 1 when 'medium' then 2 when 'low' then 3 else 4 end,
         coalesce(pp.priority_rank, 999999), mi.name,
         coalesce(case when pla.is_active then pla.allocation_pct end, 0)
    from (select distinct menu_item_id, variant_id from public.recipe_components
           where inventory_item_id = any(v_scope)) x
    join public.menu_items mi on mi.id = x.menu_item_id
    left join public.product_priority pp on pp.menu_item_id = x.menu_item_id
    left join public.priority_level_allocation pla on pla.priority_level = pp.priority_level;

  -- 2–4. Percentage rounds, then redistribution rounds of what's left.
  for v_pass in 1..8 loop
    truncate alloc_level_pool;
    insert into alloc_level_pool (level, inventory_item_id, remaining)
    with hungry as (
      -- products with a percentage that can still make at least one more
      select ap.level, ap.pct, ap.menu_item_id, ap.variant_id
        from alloc_product ap
       where ap.pct > 0
         and (select min(floor(ps.remaining / rc.qty_per_unit))
                from public.recipe_components rc
                join public.priority_stock_pool ps on ps.inventory_item_id = rc.inventory_item_id
               where rc.menu_item_id = ap.menu_item_id
                 and rc.variant_id is not distinct from ap.variant_id) > 0
    ),
    level_ing as (
      select distinct h.level, h.pct, rc.inventory_item_id
        from hungry h
        join public.recipe_components rc
          on rc.menu_item_id = h.menu_item_id and rc.variant_id is not distinct from h.variant_id
    ),
    totals as (
      select inventory_item_id, sum(pct) as total from level_ing group by inventory_item_id
    )
    select li.level, li.inventory_item_id, ps.remaining * li.pct / t.total
      from level_ing li
      join totals t on t.inventory_item_id = li.inventory_item_id
      join public.priority_stock_pool ps on ps.inventory_item_id = li.inventory_item_id
     where t.total > 0;

    v_moved := 0;
    for v_p in
      select * from alloc_product where pct > 0
       order by level_rank, rank_in_level, item_name, variant_id nulls first
    loop
      -- whole portions this product can make from its level's share of
      -- EVERY ingredient in its recipe (a missing share counts as none)
      select min(floor(coalesce(lp.remaining, 0) / rc.qty_per_unit)) into v_cap
        from public.recipe_components rc
        left join alloc_level_pool lp on lp.level = v_p.level and lp.inventory_item_id = rc.inventory_item_id
       where rc.menu_item_id = v_p.menu_item_id and rc.variant_id is not distinct from v_p.variant_id;
      v_cap := greatest(coalesce(v_cap, 0), 0);
      if v_cap > 0 then
        update alloc_level_pool lp set remaining = lp.remaining - v_cap * rc.qty_per_unit
          from public.recipe_components rc
         where rc.menu_item_id = v_p.menu_item_id and rc.variant_id is not distinct from v_p.variant_id
           and lp.level = v_p.level and lp.inventory_item_id = rc.inventory_item_id;
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

  -- 5–6. Final priority pass over every product in scope (including 0% /
  -- inactive levels, unprioritized products and modifier-only items), then
  -- write the authoritative result.
  for v_p in
    select ap.menu_item_id, ap.variant_id, ap.level_rank, ap.rank_in_level, ap.item_name, ap.claim, true as has_recipe
      from alloc_product ap
    union all
    select mg.menu_item_id, null::uuid,
           case pp.priority_level when 'critical' then 0 when 'high' then 1 when 'medium' then 2 when 'low' then 3 else 4 end,
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
    -- independent recipe capacity from live stock: the ceiling, plus the
    -- status/bottleneck/required-modifier checks
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
