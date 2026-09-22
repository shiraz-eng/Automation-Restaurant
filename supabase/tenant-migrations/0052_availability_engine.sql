-- ============================================================================
-- Tenant delta 0052 — Recipe-driven product availability engine
--
-- Layers a NEW, derived "can we actually make this right now" signal on TOP
-- of the existing manual toggles (menu_items.is_available, menu_variants./
-- deals.is_available+track_availability+available_qty) — it does not
-- replace them. A product can be manually hidden AND computed-available at
-- the same time (Owner chose to hide it); the two signals combine at the
-- read layer, never inside this engine.
--
-- product_availability: one row per (menu_item_id, variant_id) that has a
-- recipe (recipe_components) — absence of a row means "not tracked by this
-- engine", falling back entirely to the pre-existing manual system.
-- variant_id null = the item's own base/default recipe.
--
-- availability_audit_log: append-only history of every status/producible-
-- qty transition, immutable from the client (no insert/update/delete RLS
-- policy — only security definer functions write to it, same convention
-- audit_logs itself already uses).
--
-- Recalculation is dependency-aware (spec §4, §28): a stock_qty change on
-- one ingredient only recalculates the (menu_item, variant) pairs and
-- required-modifier-dependent items that actually reference it, not the
-- whole menu — mirrors low_stock_events' own trigger-driven, "recompute
-- just the affected subject" shape (schema.sql, Tenant delta 0025).
-- ============================================================================

create table public.product_availability (
  id                           uuid primary key default gen_random_uuid(),
  menu_item_id                 uuid not null references public.menu_items(id) on delete cascade,
  variant_id                   uuid references public.menu_variants(id) on delete cascade,
  status                       text not null check (status in ('available', 'low_stock', 'unavailable')),
  producible_qty                numeric(14,3),
  bottleneck_inventory_item_id uuid references public.inventory_items(id) on delete set null,
  reason                       text,
  updated_at                   timestamptz not null default now()
);
create unique index product_availability_key_idx on public.product_availability(menu_item_id, variant_id) nulls not distinct;
create index product_availability_item_idx on public.product_availability(menu_item_id);
alter table public.product_availability enable row level security;
-- Same guest_read-broad / application-curated-narrow convention modifier_groups
-- /modifier_options already use (schema.sql:1378-1379) — the customer storefront
-- route (apps/api/src/routes/public.ts) is the layer that decides customers only
-- ever see a plain available/unavailable boolean, never reason/bottleneck/qty.
create policy guest_read on public.product_availability for select using (true);
create policy staff_read on public.product_availability for select using (app.has_perm('availability.view') or app.is_staff());

create table public.availability_audit_log (
  id                           bigint generated always as identity primary key,
  menu_item_id                 uuid not null references public.menu_items(id) on delete cascade,
  variant_id                   uuid references public.menu_variants(id) on delete cascade,
  previous_status               text,
  new_status                    text not null,
  previous_producible_qty        numeric(14,3),
  new_producible_qty             numeric(14,3),
  bottleneck_inventory_item_id uuid references public.inventory_items(id) on delete set null,
  reason                       text,
  trigger_type                 text not null, -- inventory_consumption | inventory_restock | recipe_change | manual_recalculation
  trigger_reference            text,
  actor                        text not null default 'system',
  created_at                   timestamptz not null default now()
);
create index availability_audit_log_item_idx on public.availability_audit_log(menu_item_id, created_at desc);
create index availability_audit_log_created_idx on public.availability_audit_log(created_at desc);
alter table public.availability_audit_log enable row level security;
create policy staff_read on public.availability_audit_log for select using (app.has_perm('availability.view') or app.is_staff());
-- No insert/update/delete policy for any role — writes only happen through
-- app.recalc_product_availability() below (security definer), matching how
-- public.audit_logs itself is immutable from every client.

-- ── Core calculation ────────────────────────────────────────────────────
-- Mirrors place_order()'s own recipe-resolution rule exactly (schema.sql
-- ~2096-2107): a recipe_components row scoped to THIS variant fully
-- REPLACES the item's base recipe when one exists; otherwise the base
-- (variant_id is null) recipe applies. Never both, never additive.
create or replace function app.recalc_product_availability(
  p_menu_item_id uuid,
  p_variant_id uuid,
  p_trigger_type text default 'manual_recalculation',
  p_trigger_reference text default null,
  p_actor text default 'system'
) returns void
language plpgsql security definer set search_path = public, app as $$
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
  v_prev record;
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
    select rc.inventory_item_id, rc.qty_per_unit, i.stock_qty, i.min_threshold, i.name
      from public.recipe_components rc
      join public.inventory_items i on i.id = rc.inventory_item_id
     where rc.menu_item_id = p_menu_item_id
       and rc.variant_id is not distinct from v_effective_variant
  loop
    v_has_recipe := true;
    v_capacity := floor(greatest(v_comp.stock_qty, 0) / v_comp.qty_per_unit);
    if v_min_capacity is null or v_capacity < v_min_capacity then
      v_min_capacity := v_capacity;
      v_bottleneck := v_comp.inventory_item_id;
      v_bottleneck_name := v_comp.name;
      v_bottleneck_low := v_comp.stock_qty <= v_comp.min_threshold;
    end if;
  end loop;

  if v_has_recipe then
    v_tracked := true;
    v_producible := v_min_capacity;
    if v_producible <= 0 then
      v_status := 'unavailable';
      v_reason := v_bottleneck_name || ' unavailable';
    elsif v_bottleneck_low then
      -- The product itself is still sellable — only the ingredient-level
      -- min_threshold concept (already real, already shown in Inventory) is
      -- low. Keep LOW_STOCK and UNAVAILABLE genuinely distinct (spec §5/§20).
      v_status := 'low_stock';
      v_reason := v_bottleneck_name || ' approaching reorder level';
    else
      v_status := 'available';
      v_reason := null;
    end if;
  else
    -- No base/variant recipe — nothing constrains capacity from that side,
    -- but the required-modifier-group check below may still find a real
    -- constraint (e.g. a "Choose Sauce" group whose only ingredient link is
    -- on its options, not the item itself — spec §9 / §31 scenario 7).
    v_producible := null;
    v_status := 'available';
    v_reason := null;
  end if;

  -- Required modifier groups (min_select >= 1, spec §9): checked
  -- unconditionally, even when the item has no base recipe of its own —
  -- the product also needs at least one genuinely selectable, in-stock
  -- option in every such group. A required choice with nothing left to
  -- pick makes the product itself unorderable — the same failure
  -- place_order() already guards against at checkout (modifier_required),
  -- surfaced here before a customer ever gets that far.
  for v_req_group in
    select id, name from public.modifier_groups
     where menu_item_id = p_menu_item_id and min_select >= 1
  loop
    v_tracked := true;
    v_group_viable := false;
    for v_opt in
      select id from public.modifier_options where group_id = v_req_group.id and is_available
    loop
      v_opt_cap := null; -- null = unbounded (this option has no linked ingredient consumption)
      for v_opt_row in
        select mrc.qty_base, i.stock_qty
          from public.modifier_recipe_components mrc
          join public.inventory_items i on i.id = mrc.inventory_item_id
         where mrc.modifier_option_id = v_opt.id
      loop
        v_cap := floor(greatest(v_opt_row.stock_qty, 0) / v_opt_row.qty_base);
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

  if not v_tracked then
    -- Not tracked by this engine at all (no base/variant recipe AND no
    -- required modifier group) — drop any stale row rather than leaving a
    -- now-meaningless status behind.
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
    (p_menu_item_id, p_variant_id, v_status, v_producible, v_bottleneck, v_reason, now())
  on conflict (menu_item_id, variant_id) do update set
    status = excluded.status,
    producible_qty = excluded.producible_qty,
    bottleneck_inventory_item_id = excluded.bottleneck_inventory_item_id,
    reason = excluded.reason,
    updated_at = now();

  if v_prev is null or v_prev.status is distinct from v_status or v_prev.producible_qty is distinct from v_producible then
    insert into public.availability_audit_log
      (menu_item_id, variant_id, previous_status, new_status, previous_producible_qty, new_producible_qty,
       bottleneck_inventory_item_id, reason, trigger_type, trigger_reference, actor)
    values
      (p_menu_item_id, p_variant_id, v_prev.status, v_status, v_prev.producible_qty, v_producible,
       v_bottleneck, v_reason, p_trigger_type, p_trigger_reference, p_actor);
    perform app.log_action('availability.changed', 'menu_items', p_menu_item_id::text, null,
      jsonb_build_object('variant_id', p_variant_id, 'status', v_status, 'producible_qty', v_producible, 'reason', v_reason));
  end if;
end;
$$;

-- ── Dependency-aware fan-out: recompute only what a changed ingredient
-- could actually affect (spec §4, §28) ───────────────────────────────────
create or replace function app.recalc_products_for_ingredient(
  p_inventory_item_id uuid, p_trigger_type text, p_trigger_reference text default null
) returns void
language plpgsql security definer set search_path = public, app as $$
declare r record;
begin
  for r in
    select distinct menu_item_id, variant_id from public.recipe_components
     where inventory_item_id = p_inventory_item_id
  loop
    perform app.recalc_product_availability(r.menu_item_id, r.variant_id, p_trigger_type, p_trigger_reference);
  end loop;

  -- Items with an already-tracked row whose REQUIRED modifier group
  -- consumes this ingredient — recheck every variant row that item has.
  for r in
    select distinct x.menu_item_id, x.variant_id
      from public.modifier_recipe_components mrc
      join public.modifier_options mo on mo.id = mrc.modifier_option_id
      join public.modifier_groups mg on mg.id = mo.group_id
      join public.product_availability x on x.menu_item_id = mg.menu_item_id
     where mrc.inventory_item_id = p_inventory_item_id
  loop
    perform app.recalc_product_availability(r.menu_item_id, r.variant_id, p_trigger_type, p_trigger_reference);
  end loop;

  -- Same, for an item that has never had a base-recipe row tracked yet (so
  -- the join above finds nothing) but DOES have a required modifier group
  -- depending on this ingredient — recalc its base row so a modifier-driven
  -- unavailable state is still captured from a cold start.
  for r in
    select distinct mg.menu_item_id
      from public.modifier_recipe_components mrc
      join public.modifier_options mo on mo.id = mrc.modifier_option_id
      join public.modifier_groups mg on mg.id = mo.group_id
     where mrc.inventory_item_id = p_inventory_item_id
       and not exists (select 1 from public.product_availability x where x.menu_item_id = mg.menu_item_id)
  loop
    perform app.recalc_product_availability(r.menu_item_id, null, p_trigger_type, p_trigger_reference);
  end loop;
end;
$$;

create or replace function app.on_inventory_stock_change() returns trigger
language plpgsql security definer set search_path = public, app as $$
begin
  if new.stock_qty is distinct from old.stock_qty then
    perform app.recalc_products_for_ingredient(
      new.id,
      case when new.stock_qty > old.stock_qty then 'inventory_restock' else 'inventory_consumption' end,
      null
    );
  end if;
  return new;
end;
$$;
drop trigger if exists recalc_availability_on_stock_change on public.inventory_items;
create trigger recalc_availability_on_stock_change after update of stock_qty on public.inventory_items
  for each row execute function app.on_inventory_stock_change();

create or replace function app.on_recipe_components_change() returns trigger
language plpgsql security definer set search_path = public, app as $$
declare v_item uuid; v_variant uuid;
begin
  if tg_op = 'DELETE' then
    v_item := old.menu_item_id; v_variant := old.variant_id;
  else
    v_item := new.menu_item_id; v_variant := new.variant_id;
  end if;
  perform app.recalc_product_availability(v_item, v_variant, 'recipe_change', null);
  -- A variant-specific row being added/removed can flip which recipe is
  -- "effective" for that variant (replace vs. fall back to base) — recalc
  -- the base row too so that fallback is reflected immediately either way.
  if v_variant is not null then
    perform app.recalc_product_availability(v_item, null, 'recipe_change', null);
  end if;
  return coalesce(new, old);
end;
$$;
drop trigger if exists recalc_availability_on_recipe_change on public.recipe_components;
create trigger recalc_availability_on_recipe_change after insert or update or delete on public.recipe_components
  for each row execute function app.on_recipe_components_change();

create or replace function app.on_modifier_recipe_components_change() returns trigger
language plpgsql security definer set search_path = public, app as $$
declare v_option uuid; v_item uuid; r record;
begin
  v_option := coalesce(new.modifier_option_id, old.modifier_option_id);
  select mg.menu_item_id into v_item
    from public.modifier_options mo join public.modifier_groups mg on mg.id = mo.group_id
   where mo.id = v_option;
  if v_item is not null then
    for r in select variant_id from public.product_availability where menu_item_id = v_item loop
      perform app.recalc_product_availability(v_item, r.variant_id, 'recipe_change', null);
    end loop;
    perform app.recalc_product_availability(v_item, null, 'recipe_change', null);
  end if;
  return coalesce(new, old);
end;
$$;
drop trigger if exists recalc_availability_on_modifier_recipe_change on public.modifier_recipe_components;
create trigger recalc_availability_on_modifier_recipe_change after insert or update or delete on public.modifier_recipe_components
  for each row execute function app.on_modifier_recipe_components_change();

create or replace function app.on_modifier_option_availability_change() returns trigger
language plpgsql security definer set search_path = public, app as $$
declare v_item uuid; r record;
begin
  if new.is_available is distinct from old.is_available then
    select mg.menu_item_id into v_item from public.modifier_groups mg where mg.id = new.group_id;
    if v_item is not null then
      for r in select variant_id from public.product_availability where menu_item_id = v_item loop
        perform app.recalc_product_availability(v_item, r.variant_id, 'recipe_change', null);
      end loop;
      perform app.recalc_product_availability(v_item, null, 'recipe_change', null);
    end if;
  end if;
  return new;
end;
$$;
drop trigger if exists recalc_availability_on_modifier_option_change on public.modifier_options;
create trigger recalc_availability_on_modifier_option_change after update of is_available on public.modifier_options
  for each row execute function app.on_modifier_option_availability_change();

-- ── Public read/action surface ─────────────────────────────────────────

-- Ingredient-by-ingredient breakdown for one product (spec §18 "Product
-- Availability Detail") — the same resolution rule and live numbers
-- app.recalc_product_availability() uses, exposed for the Menu editor / AI.
create or replace function public.get_product_availability_detail(p_menu_item_id uuid, p_variant_id uuid default null)
returns table (
  inventory_item_id uuid, ingredient_name text, unit text,
  stock_qty numeric, qty_per_unit numeric, capacity numeric
)
language plpgsql security definer set search_path = public, app as $$
declare v_effective_variant uuid; v_has_variant_recipe boolean;
begin
  if not (app.has_perm('availability.view') or app.has_perm('inventory.view_cost') or app.is_staff()) then
    raise exception 'forbidden' using errcode = 'insufficient_privilege';
  end if;
  if p_variant_id is not null then
    select exists(select 1 from public.recipe_components where menu_item_id = p_menu_item_id and variant_id = p_variant_id)
      into v_has_variant_recipe;
    v_effective_variant := case when v_has_variant_recipe then p_variant_id else null end;
  else
    v_effective_variant := null;
  end if;
  return query
    select rc.inventory_item_id, i.name, i.unit, i.stock_qty, rc.qty_per_unit,
           floor(greatest(i.stock_qty, 0) / rc.qty_per_unit) as capacity
      from public.recipe_components rc
      join public.inventory_items i on i.id = rc.inventory_item_id
     where rc.menu_item_id = p_menu_item_id and rc.variant_id is not distinct from v_effective_variant
     order by capacity asc;
end;
$$;
revoke all on function public.get_product_availability_detail(uuid, uuid) from public;
grant execute on function public.get_product_availability_detail(uuid, uuid) to authenticated, service_role;

-- Manual full recompute — for the initial backfill on existing tenants
-- (nothing is tracked until this runs once) and an explicit "Recalculate"
-- action if an Owner ever wants to force a refresh.
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
  -- Items with no base/variant recipe at all, but a required modifier
  -- group of their own — recalc_product_availability() tracks these too
  -- (spec §31 scenario 7), so the bulk backfill needs to reach them even
  -- though recipe_components has no row for them.
  for r in
    select distinct mg.menu_item_id
      from public.modifier_groups mg
     where mg.min_select >= 1
       and not exists (select 1 from public.recipe_components rc where rc.menu_item_id = mg.menu_item_id)
  loop
    perform app.recalc_product_availability(r.menu_item_id, null, 'manual_recalculation', null);
  end loop;
end;
$$;
revoke all on function public.recalculate_all_product_availability() from public;
grant execute on function public.recalculate_all_product_availability() to authenticated, service_role;

alter publication supabase_realtime add table public.product_availability;
