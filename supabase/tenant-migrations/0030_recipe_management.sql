-- 0030: Recipe Management System. Recipes become the authoritative, named,
-- versioned definition of what a menu item (or a semi-finished/prep
-- component) consumes — sitting ABOVE recipe_components, not beside it.
-- recipe_components stays exactly what place_order() already reads
-- (completely untouched by this migration); activating a recipe version
-- syncs its resolved ingredient list into recipe_components, so the
-- proven order/consumption/COGS pipeline built earlier keeps working
-- exactly as before, unaware this versioned layer exists above it.
-- ── Recipe Management ────────────────────────────────────────────────────
-- Recipes are the authoritative, NAMED, VERSIONED definition of what a menu
-- item (or a semi-finished/prep component) consumes. They sit ABOVE
-- recipe_components, not beside it: recipe_components stays exactly what
-- place_order() already reads (untouched — the order/consumption/COGS
-- pipeline built earlier keeps working exactly as before), and activating
-- a recipe version SYNCS its resolved ingredient list into
-- recipe_components for the (menu_item_id, variant_id) it targets. That
-- avoids a second, divergent consumption system while adding real naming,
-- status and version history recipe_components alone can't express.
--
-- Ingredient quantities (recipe_ingredients.qty_base) are always in the
-- target's own BASE unit — the exact same convention inventory_items and
-- recipe_components already use (spec §6-7's "150g per burger" resolves
-- against inventory_items.unit directly). There is deliberately no second
-- unit-conversion system: a recipe line never offers a choice of unit to
-- convert FROM, so an incompatible conversion (spec §9 — "150 ml against a
-- kg-based item") has no way to be expressed in the first place, rather
-- than being entered and then rejected.
do $$ begin
  if not exists (select 1 from pg_type where typname = 'recipe_type' and typnamespace = 'app'::regnamespace) then
    create type app.recipe_type as enum ('menu_item', 'variant', 'semi_finished', 'preparation');
  end if;
  if not exists (select 1 from pg_type where typname = 'recipe_status' and typnamespace = 'app'::regnamespace) then
    create type app.recipe_status as enum ('draft', 'active', 'archived');
  end if;
end $$;

-- The recipe's stable identity: its name, what it's for, and — for a
-- menu_item/variant recipe — which product it defines. current_version_id
-- is maintained by activate_recipe_version(); status mirrors whichever
-- version is current (draft until something is activated, archived once
-- the whole recipe is retired).
create table if not exists public.recipes (
  id                  uuid primary key default gen_random_uuid(),
  name                text not null,
  description         text,
  notes               text,
  recipe_type         app.recipe_type not null default 'menu_item',
  menu_item_id        uuid references public.menu_items(id) on delete cascade,
  variant_id          uuid references public.menu_variants(id) on delete cascade,
  status              app.recipe_status not null default 'draft',
  current_version_id  uuid,
  instructions        text,
  created_by          uuid,
  created_at          timestamptz not null default now(),
  -- A menu_item/variant recipe must point at a product; a semi_finished/
  -- preparation recipe (a batch other recipes consume FROM) must not.
  check ((recipe_type in ('menu_item','variant')) = (menu_item_id is not null)),
  check (recipe_type = 'variant' or variant_id is null)
);
create index if not exists recipes_menu_item_idx on public.recipes(menu_item_id, variant_id);
-- At most one non-archived recipe per product — matches recipe_components'
-- own (menu_item_id, variant_id) uniqueness, so there is never ambiguity
-- about which recipe a product's consumption comes from.
create unique index if not exists recipes_one_live_per_product_idx on public.recipes(menu_item_id, coalesce(variant_id, '00000000-0000-0000-0000-000000000000'))
  where status <> 'archived' and recipe_type in ('menu_item', 'variant');

-- One row per version ever created for a recipe (spec §16's historical
-- ledger). Only one version per recipe is ever 'active'; activate_recipe_
-- version() enforces that by archiving whichever one currently holds it.
-- effective_from/effective_to record exactly when each version was live,
-- for cost-history and "what recipe made this order" questions.
create table if not exists public.recipe_versions (
  id              uuid primary key default gen_random_uuid(),
  recipe_id       uuid not null references public.recipes(id) on delete cascade,
  version         int not null check (version > 0),
  status          app.recipe_status not null default 'draft',
  yield_qty       numeric(14,3) not null default 1 check (yield_qty > 0),
  yield_unit      text,  -- display label; null = "1 serving" for a menu_item/variant recipe
  effective_from  timestamptz,
  effective_to    timestamptz,
  created_by      uuid,
  created_at      timestamptz not null default now(),
  unique (recipe_id, version)
);
create index if not exists recipe_versions_recipe_idx on public.recipe_versions(recipe_id, version desc);
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'recipes_current_version_fk') then
    alter table public.recipes add constraint recipes_current_version_fk
      foreign key (current_version_id) references public.recipe_versions(id) on delete set null;
  end if;
end $$;

-- One ingredient line in a recipe version — either a raw inventory item or
-- a sub-recipe (a semi_finished/preparation recipe this line draws its
-- yield from), never both (spec §12-13).
create table if not exists public.recipe_ingredients (
  id                  uuid primary key default gen_random_uuid(),
  recipe_version_id   uuid not null references public.recipe_versions(id) on delete cascade,
  inventory_item_id   uuid references public.inventory_items(id) on delete restrict,
  sub_recipe_id       uuid references public.recipes(id) on delete restrict,
  qty_base            numeric(14,3) not null check (qty_base > 0),
  sort_order          int not null default 0,
  check ((inventory_item_id is null) <> (sub_recipe_id is null))
);
create index if not exists recipe_ingredients_version_idx on public.recipe_ingredients(recipe_version_id, sort_order);
-- No duplicate ingredient rows within one version (spec §28).
create unique index if not exists recipe_ingredients_unique_item_idx on public.recipe_ingredients(recipe_version_id, inventory_item_id) where inventory_item_id is not null;
create unique index if not exists recipe_ingredients_unique_sub_idx on public.recipe_ingredients(recipe_version_id, sub_recipe_id) where sub_recipe_id is not null;

-- Append-only recipe cost history (spec §24, §26): one row whenever a
-- version's computed cost differs from the last logged value for it —
-- written at activation and by the periodic snapshot sweep (server-side,
-- mirrors the low-stock sweep), so an ingredient price change ALONE, with
-- no recipe edit at all, still shows up as a tracked cost change.
create table if not exists public.recipe_cost_log (
  id                  uuid primary key default gen_random_uuid(),
  recipe_version_id   uuid not null references public.recipe_versions(id) on delete cascade,
  cost_cents          int not null,
  recorded_at         timestamptz not null default now()
);
create index if not exists recipe_cost_log_version_idx on public.recipe_cost_log(recipe_version_id, recorded_at desc);

-- Explodes a recipe version down to raw inventory quantities, resolving
-- any sub-recipe ingredient through ITS active version and yield (spec
-- §12-13 semi-finished/preparation support) — this is what
-- activate_recipe_version() writes into recipe_components. p_visited
-- guards against a circular chain looping forever; activate_recipe_
-- version() already refuses to activate anything that would create one,
-- so this is defense in depth, not the primary guard.
create or replace function public.resolve_recipe_ingredients(p_recipe_version_id uuid, p_multiplier numeric default 1, p_visited uuid[] default '{}')
returns table (inventory_item_id uuid, qty_base numeric)
language plpgsql stable security definer set search_path = public, app as $fn$
declare
  v_line record;
  v_sub_active uuid;
  v_sub_yield numeric;
begin
  if p_recipe_version_id = any(p_visited) then
    return;
  end if;
  for v_line in
    select ri.qty_base as q, ri.inventory_item_id as ii, ri.sub_recipe_id as sr
      from public.recipe_ingredients ri
     where ri.recipe_version_id = p_recipe_version_id
  loop
    if v_line.ii is not null then
      inventory_item_id := v_line.ii;
      qty_base := v_line.q * p_multiplier;
      return next;
    else
      select r.current_version_id into v_sub_active from public.recipes r where r.id = v_line.sr;
      if v_sub_active is not null then
        select rv.yield_qty into v_sub_yield from public.recipe_versions rv where rv.id = v_sub_active;
        return query select * from public.resolve_recipe_ingredients(
          v_sub_active,
          p_multiplier * v_line.q / greatest(coalesce(v_sub_yield, 1), 0.0001),
          p_visited || p_recipe_version_id
        );
      end if;
    end if;
  end loop;
end;
$fn$;

-- Total cost to produce one full batch (yield_qty units) of a recipe
-- version — divide by yield_qty for cost-per-yield-unit (cost per serving
-- for a menu_item/variant recipe, since those always yield 1).
create or replace function public.recipe_version_total_cost(p_recipe_version_id uuid)
returns int language sql stable security definer set search_path = public, app as $fn$
  select coalesce(sum(round(x.qty_base * coalesce(i.cost_cents_per_base_unit, 0))), 0)::int
    from public.resolve_recipe_ingredients(p_recipe_version_id) x
    join public.inventory_items i on i.id = x.inventory_item_id;
$fn$;
grant execute on function public.recipe_version_total_cost(uuid) to authenticated, service_role;

create or replace function public.recipe_version_cost_per_yield_unit(p_recipe_version_id uuid)
returns int language sql stable security definer set search_path = public, app as $fn$
  select round(public.recipe_version_total_cost(p_recipe_version_id) / greatest(rv.yield_qty, 0.0001))::int
    from public.recipe_versions rv where rv.id = p_recipe_version_id;
$fn$;
grant execute on function public.recipe_version_cost_per_yield_unit(uuid) to authenticated, service_role;

-- Create a new recipe as a draft, with its first version and ingredient
-- list, in one transaction (spec §52 "select item -> add ingredients ->
-- system calculates cost -> review -> save").
create or replace function public.create_recipe(
  p_name text, p_description text, p_notes text, p_recipe_type app.recipe_type,
  p_menu_item_id uuid, p_variant_id uuid, p_instructions text,
  p_yield_qty numeric, p_yield_unit text, p_ingredients jsonb
) returns table (recipe_id uuid, recipe_version_id uuid, cost_cents int)
language plpgsql security definer set search_path = public, app as $fn$
declare
  v_recipe_id uuid; v_version_id uuid; v_ing jsonb; v_cost int;
begin
  if not (app.has_perm('inventory.manage_recipes') or app.has_perm('finance.manage_recipes') or app.can_write()) then
    raise exception 'forbidden' using errcode = 'insufficient_privilege';
  end if;
  if coalesce(trim(p_name), '') = '' then
    raise exception 'recipe_name_required' using errcode = 'check_violation';
  end if;
  if p_ingredients is null or jsonb_typeof(p_ingredients) <> 'array' or jsonb_array_length(p_ingredients) = 0 then
    raise exception 'recipe_needs_ingredients' using errcode = 'check_violation';
  end if;
  if p_recipe_type in ('menu_item', 'variant') and p_menu_item_id is null then
    raise exception 'recipe_needs_menu_item' using errcode = 'check_violation';
  end if;

  insert into public.recipes (name, description, notes, recipe_type, menu_item_id, variant_id, instructions, status, created_by)
  values (trim(p_name), nullif(trim(coalesce(p_description, '')), ''), nullif(trim(coalesce(p_notes, '')), ''),
          p_recipe_type, p_menu_item_id, p_variant_id, nullif(trim(coalesce(p_instructions, '')), ''), 'draft', app.jwt_sub())
  returning id into v_recipe_id;

  insert into public.recipe_versions (recipe_id, version, status, yield_qty, yield_unit, created_by)
  values (v_recipe_id, 1, 'draft', greatest(coalesce(p_yield_qty, 1), 0.0001), nullif(trim(coalesce(p_yield_unit, '')), ''), app.jwt_sub())
  returning id into v_version_id;

  for v_ing in select * from jsonb_array_elements(p_ingredients) loop
    insert into public.recipe_ingredients (recipe_version_id, inventory_item_id, sub_recipe_id, qty_base, sort_order)
    values (
      v_version_id,
      nullif(v_ing->>'inventory_item_id', '')::uuid,
      nullif(v_ing->>'sub_recipe_id', '')::uuid,
      (v_ing->>'qty_base')::numeric,
      coalesce((v_ing->>'sort_order')::int, 0)
    );
  end loop;

  v_cost := public.recipe_version_total_cost(v_version_id);
  perform app.log_action('recipe.created', 'recipes', v_recipe_id::text, null,
    jsonb_build_object('name', p_name, 'version_id', v_version_id, 'cost_cents', v_cost));

  return query select v_recipe_id, v_version_id, v_cost;
end;
$fn$;
revoke all on function public.create_recipe(text, text, text, app.recipe_type, uuid, uuid, text, numeric, text, jsonb) from public;
grant execute on function public.create_recipe(text, text, text, app.recipe_type, uuid, uuid, text, numeric, text, jsonb) to authenticated, service_role;

-- Create a new DRAFT version of an existing recipe, carrying forward the
-- previous version's yield unless overridden (spec §16 — editing a recipe
-- never overwrites history, it creates the next version).
create or replace function public.create_recipe_version(
  p_recipe_id uuid, p_ingredients jsonb, p_yield_qty numeric default null, p_yield_unit text default null
) returns table (recipe_version_id uuid, cost_cents int)
language plpgsql security definer set search_path = public, app as $fn$
declare
  v_next_version int; v_version_id uuid; v_ing jsonb; v_cost int;
  v_prev_yield_qty numeric; v_prev_yield_unit text;
begin
  if not (app.has_perm('inventory.manage_recipes') or app.has_perm('finance.manage_recipes') or app.can_write()) then
    raise exception 'forbidden' using errcode = 'insufficient_privilege';
  end if;
  if not exists (select 1 from public.recipes where id = p_recipe_id) then
    raise exception 'recipe_not_found' using errcode = 'no_data_found';
  end if;
  if p_ingredients is null or jsonb_typeof(p_ingredients) <> 'array' or jsonb_array_length(p_ingredients) = 0 then
    raise exception 'recipe_needs_ingredients' using errcode = 'check_violation';
  end if;

  select coalesce(max(version), 0) + 1 into v_next_version from public.recipe_versions where recipe_id = p_recipe_id;
  select yield_qty, yield_unit into v_prev_yield_qty, v_prev_yield_unit
    from public.recipe_versions where recipe_id = p_recipe_id order by version desc limit 1;

  insert into public.recipe_versions (recipe_id, version, status, yield_qty, yield_unit, created_by)
  values (p_recipe_id, v_next_version, 'draft',
          greatest(coalesce(p_yield_qty, v_prev_yield_qty, 1), 0.0001),
          coalesce(nullif(trim(coalesce(p_yield_unit, '')), ''), v_prev_yield_unit), app.jwt_sub())
  returning id into v_version_id;

  for v_ing in select * from jsonb_array_elements(p_ingredients) loop
    insert into public.recipe_ingredients (recipe_version_id, inventory_item_id, sub_recipe_id, qty_base, sort_order)
    values (
      v_version_id,
      nullif(v_ing->>'inventory_item_id', '')::uuid,
      nullif(v_ing->>'sub_recipe_id', '')::uuid,
      (v_ing->>'qty_base')::numeric,
      coalesce((v_ing->>'sort_order')::int, 0)
    );
  end loop;

  v_cost := public.recipe_version_total_cost(v_version_id);
  perform app.log_action('recipe.version_created', 'recipes', p_recipe_id::text, null,
    jsonb_build_object('version', v_next_version, 'version_id', v_version_id, 'cost_cents', v_cost));

  return query select v_version_id, v_cost;
end;
$fn$;
revoke all on function public.create_recipe_version(uuid, jsonb, numeric, text) from public;
grant execute on function public.create_recipe_version(uuid, jsonb, numeric, text) to authenticated, service_role;

-- Make a draft version the live one (spec §17-18). Validates ingredients
-- exist and the recipe has a product to attach to, rejects a version whose
-- sub-recipe chain would become circular (spec §29), archives whichever
-- version currently holds 'active', and — for a menu_item/variant recipe —
-- syncs the resolved (sub-recipes exploded to raw quantities) ingredient
-- list into recipe_components, which is ALL place_order() ever reads. This
-- is the one place a recipe change becomes live production consumption.
create or replace function public.activate_recipe_version(p_recipe_version_id uuid)
returns void language plpgsql security definer set search_path = public, app as $fn$
declare
  v_recipe_id uuid; v_recipe public.recipes; v_prev_active uuid; v_cost int;
begin
  if not (app.has_perm('inventory.manage_recipes') or app.has_perm('finance.manage_recipes') or app.can_write()) then
    raise exception 'forbidden' using errcode = 'insufficient_privilege';
  end if;

  select recipe_id into v_recipe_id from public.recipe_versions where id = p_recipe_version_id;
  if v_recipe_id is null then raise exception 'recipe_version_not_found' using errcode = 'no_data_found'; end if;
  select * into v_recipe from public.recipes where id = v_recipe_id;

  if not exists (select 1 from public.recipe_ingredients where recipe_version_id = p_recipe_version_id) then
    raise exception 'recipe_needs_ingredients' using errcode = 'check_violation';
  end if;
  if v_recipe.recipe_type in ('menu_item', 'variant') and v_recipe.menu_item_id is null then
    raise exception 'recipe_needs_menu_item' using errcode = 'check_violation';
  end if;

  -- Circular-dependency guard: walk the sub-recipe graph this version
  -- would introduce (through OTHER recipes' currently-active versions —
  -- a draft elsewhere doesn't count until it too is activated, at which
  -- point this same check runs for it) and refuse if it ever leads back
  -- to this recipe.
  if exists (
    with recursive dep(recipe_id) as (
      select ri.sub_recipe_id from public.recipe_ingredients ri
       where ri.recipe_version_id = p_recipe_version_id and ri.sub_recipe_id is not null
      union
      select ri2.sub_recipe_id
        from dep
        join public.recipes r2 on r2.id = dep.recipe_id
        join public.recipe_ingredients ri2
          on ri2.recipe_version_id = coalesce(r2.current_version_id, '00000000-0000-0000-0000-000000000000'::uuid)
         and ri2.sub_recipe_id is not null
    )
    select 1 from dep where recipe_id = v_recipe_id
  ) then
    raise exception 'circular_recipe_dependency' using errcode = 'check_violation';
  end if;

  select id into v_prev_active from public.recipe_versions where recipe_id = v_recipe_id and status = 'active';
  if v_prev_active is not null then
    update public.recipe_versions set status = 'archived', effective_to = now() where id = v_prev_active;
  end if;
  update public.recipe_versions set status = 'active', effective_from = now(), effective_to = null where id = p_recipe_version_id;
  update public.recipes set status = 'active', current_version_id = p_recipe_version_id where id = v_recipe_id;

  if v_recipe.recipe_type in ('menu_item', 'variant') then
    delete from public.recipe_components
     where menu_item_id = v_recipe.menu_item_id and variant_id is not distinct from v_recipe.variant_id;
    insert into public.recipe_components (menu_item_id, variant_id, inventory_item_id, qty_per_unit)
    select v_recipe.menu_item_id, v_recipe.variant_id, x.inventory_item_id, sum(x.qty_base)
      from public.resolve_recipe_ingredients(p_recipe_version_id) x
     group by x.inventory_item_id;
  end if;

  v_cost := public.recipe_version_total_cost(p_recipe_version_id);
  insert into public.recipe_cost_log (recipe_version_id, cost_cents) values (p_recipe_version_id, v_cost);

  perform app.log_action('recipe.activated', 'recipes', v_recipe_id::text,
    jsonb_build_object('previous_version_id', v_prev_active),
    jsonb_build_object('active_version_id', p_recipe_version_id, 'cost_cents', v_cost));
end;
$fn$;
revoke all on function public.activate_recipe_version(uuid) from public;
grant execute on function public.activate_recipe_version(uuid) to authenticated, service_role;

-- Retire a recipe entirely (spec §17): removes it from what place_order()
-- can consume (deletes its recipe_components rows for menu_item/variant
-- recipes) but never touches order_lines.recipe_cost_cents snapshots or
-- recipe_versions history — those stay exactly as they were.
create or replace function public.archive_recipe(p_recipe_id uuid)
returns void language plpgsql security definer set search_path = public, app as $fn$
declare v_recipe public.recipes;
begin
  if not (app.has_perm('inventory.manage_recipes') or app.has_perm('finance.manage_recipes') or app.can_write()) then
    raise exception 'forbidden' using errcode = 'insufficient_privilege';
  end if;
  select * into v_recipe from public.recipes where id = p_recipe_id;
  if v_recipe.id is null then raise exception 'recipe_not_found' using errcode = 'no_data_found'; end if;

  update public.recipes set status = 'archived' where id = p_recipe_id;
  update public.recipe_versions set status = 'archived', effective_to = coalesce(effective_to, now())
   where recipe_id = p_recipe_id and status = 'active';

  if v_recipe.recipe_type in ('menu_item', 'variant') then
    delete from public.recipe_components
     where menu_item_id = v_recipe.menu_item_id and variant_id is not distinct from v_recipe.variant_id;
  end if;

  perform app.log_action('recipe.archived', 'recipes', p_recipe_id::text, null, null);
end;
$fn$;
revoke all on function public.archive_recipe(uuid) from public;
grant execute on function public.archive_recipe(uuid) to authenticated, service_role;

-- Periodic sweep (spec §24, §35 — cost-change detection independent of any
-- recipe edit, e.g. a supplier price change alone): logs a new
-- recipe_cost_log row for every active recipe version whose computed cost
-- has moved since it was last logged. Called by the server's scheduled
-- sweep (mirrors the low-stock sweep) — service_role only, not a
-- staff-facing RPC.
create or replace function public.snapshot_recipe_cost_changes()
returns table (recipe_id uuid, recipe_version_id uuid, previous_cost_cents int, new_cost_cents int)
language plpgsql security definer set search_path = public, app as $fn$
declare
  v_rv record; v_new_cost int; v_last_cost int;
begin
  -- source_recipe_id (not recipe_id) — the OUT param recipe_id shares this
  -- function's scope, and a bare/ambiguously-named column reference here
  -- resolves against the OUT param instead of the query, same footgun
  -- fixed elsewhere in this file: always alias distinctly, never bare.
  for v_rv in select rv.id as version_id, rv.recipe_id as source_recipe_id from public.recipe_versions rv where rv.status = 'active' loop
    v_new_cost := public.recipe_version_total_cost(v_rv.version_id);
    select rcl.cost_cents into v_last_cost from public.recipe_cost_log rcl
     where rcl.recipe_version_id = v_rv.version_id order by rcl.recorded_at desc limit 1;
    if v_last_cost is null or v_last_cost <> v_new_cost then
      insert into public.recipe_cost_log (recipe_version_id, cost_cents) values (v_rv.version_id, v_new_cost);
      recipe_id := v_rv.source_recipe_id;
      recipe_version_id := v_rv.version_id;
      previous_cost_cents := v_last_cost;
      new_cost_cents := v_new_cost;
      return next;
    end if;
  end loop;
end;
$fn$;
revoke all on function public.snapshot_recipe_cost_changes() from public;
grant execute on function public.snapshot_recipe_cost_changes() to service_role;

alter table public.recipes enable row level security;
drop policy if exists staff_read on public.recipes;
create policy staff_read on public.recipes for select using (app.has_perm('menu.view') or app.is_staff());
drop policy if exists mgr_write on public.recipes;
create policy mgr_write on public.recipes for all
  using (app.has_perm('inventory.manage_recipes') or app.has_perm('finance.manage_recipes') or app.can_write())
  with check (app.has_perm('inventory.manage_recipes') or app.has_perm('finance.manage_recipes') or app.can_write());

alter table public.recipe_versions enable row level security;
drop policy if exists staff_read on public.recipe_versions;
create policy staff_read on public.recipe_versions for select using (app.has_perm('menu.view') or app.is_staff());
drop policy if exists mgr_write on public.recipe_versions;
create policy mgr_write on public.recipe_versions for all
  using (app.has_perm('inventory.manage_recipes') or app.has_perm('finance.manage_recipes') or app.can_write())
  with check (app.has_perm('inventory.manage_recipes') or app.has_perm('finance.manage_recipes') or app.can_write());

alter table public.recipe_ingredients enable row level security;
drop policy if exists staff_read on public.recipe_ingredients;
create policy staff_read on public.recipe_ingredients for select using (app.has_perm('menu.view') or app.is_staff());
drop policy if exists mgr_write on public.recipe_ingredients;
create policy mgr_write on public.recipe_ingredients for all
  using (app.has_perm('inventory.manage_recipes') or app.has_perm('finance.manage_recipes') or app.can_write())
  with check (app.has_perm('inventory.manage_recipes') or app.has_perm('finance.manage_recipes') or app.can_write());

-- Cost figures only, unlike the tables above — gated on inventory.view_cost
-- (not menu.view) so kitchen-only roles see recipes/instructions but not
-- the cost trend, matching how InventoryManager already hides dollar
-- columns from roles without inventory.view_cost.
alter table public.recipe_cost_log enable row level security;
drop policy if exists staff_read on public.recipe_cost_log;
create policy staff_read on public.recipe_cost_log for select using (app.has_perm('inventory.view_cost') or app.can_write());


-- Backfill: wrap any EXISTING recipe_components rows (from before this
-- migration) into a proper "Version 1, Active" recipe, one per distinct
-- (menu_item_id, variant_id) pair that doesn't already have a recipes row.
-- Idempotent — skips any pair that already has one, so re-running this
-- migration (or applying it to a tenant that already ran it) is a no-op.
do $$
declare
  v_pair record;
  v_recipe_id uuid;
  v_version_id uuid;
  v_item_name text;
  v_variant_name text;
begin
  for v_pair in
    select distinct rc.menu_item_id, rc.variant_id
      from public.recipe_components rc
     where not exists (
       select 1 from public.recipes r
        where r.menu_item_id = rc.menu_item_id
          and r.variant_id is not distinct from rc.variant_id
     )
  loop
    v_variant_name := null;
    select name into v_item_name from public.menu_items where id = v_pair.menu_item_id;
    if v_pair.variant_id is not null then
      select name into v_variant_name from public.menu_variants where id = v_pair.variant_id;
    end if;

    insert into public.recipes (name, recipe_type, menu_item_id, variant_id, status)
    values (
      coalesce(v_item_name, 'Recipe') || case when v_variant_name is not null then ' · ' || v_variant_name else '' end,
      case when v_pair.variant_id is not null then 'variant' else 'menu_item' end::app.recipe_type,
      v_pair.menu_item_id, v_pair.variant_id, 'active'
    )
    returning id into v_recipe_id;

    insert into public.recipe_versions (recipe_id, version, status, yield_qty, effective_from)
    values (v_recipe_id, 1, 'active', 1, now())
    returning id into v_version_id;

    insert into public.recipe_ingredients (recipe_version_id, inventory_item_id, qty_base, sort_order)
    select v_version_id, rc.inventory_item_id, rc.qty_per_unit,
           row_number() over (order by rc.inventory_item_id)
      from public.recipe_components rc
     where rc.menu_item_id = v_pair.menu_item_id and rc.variant_id is not distinct from v_pair.variant_id;

    update public.recipes set current_version_id = v_version_id where id = v_recipe_id;

    insert into public.recipe_cost_log (recipe_version_id, cost_cents)
    values (v_version_id, public.recipe_version_total_cost(v_version_id));
  end loop;
end $$;
-- The most recent meaningful cost move (>= p_min_pct, or any move off a
-- previously-zero cost) for every active recipe, comparing its two most
-- recent recipe_cost_log entries — powers AI Management's "recipe cost
-- alert" (spec §35) and the AI assistant's "why did my recipe cost
-- change" questions, both reading the SAME evidence, never a separate
-- calculation.
create or replace function public.recipe_recent_cost_changes(p_min_pct numeric default 5)
returns table (
  recipe_id uuid, name text, recipe_version_id uuid,
  previous_cost_cents int, new_cost_cents int, change_cents int, change_pct numeric
)
language plpgsql stable security definer set search_path = public, app as $fn$
begin
  if not app.has_perm('inventory.view_cost') then
    raise exception 'forbidden' using errcode = 'insufficient_privilege';
  end if;
  return query
    with ranked as (
      select rcl.recipe_version_id as rv_id, rcl.cost_cents as c,
             row_number() over (partition by rcl.recipe_version_id order by rcl.recorded_at desc) as rn
        from public.recipe_cost_log rcl
        join public.recipe_versions rv on rv.id = rcl.recipe_version_id and rv.status = 'active'
    ),
    paired as (
      select a.rv_id as rvid, b.c as prev_cost, a.c as curr_cost
        from ranked a
        join ranked b on b.rv_id = a.rv_id and b.rn = 2
       where a.rn = 1
    )
    select r.id, r.name, p.rvid, p.prev_cost, p.curr_cost, p.curr_cost - p.prev_cost,
           case when p.prev_cost > 0
                then round((p.curr_cost - p.prev_cost)::numeric / p.prev_cost * 1000) / 10
                else null end
      from paired p
      join public.recipe_versions rv on rv.id = p.rvid
      join public.recipes r on r.id = rv.recipe_id
     where p.prev_cost is distinct from p.curr_cost
       and (
         p.prev_cost = 0
         or abs(p.curr_cost - p.prev_cost)::numeric / greatest(p.prev_cost, 1) * 100 >= p_min_pct
       )
     order by abs(p.curr_cost - p.prev_cost) desc;
end;
$fn$;
revoke all on function public.recipe_recent_cost_changes(numeric) from public;
grant execute on function public.recipe_recent_cost_changes(numeric) to authenticated, service_role;
