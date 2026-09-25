-- 0068: recipes first, linked to a menu item by hand.
--
-- Before: a dish recipe HAD to name its menu item when it was created, so
-- the Recipes page created or attached a product on save and AI recipe
-- import matched every recipe to a dish by name. Now a dish recipe can
-- exist on its own; whoever designs the menu links it (or unlinks it)
-- explicitly with link_recipe()/unlink_recipe(). Nothing links itself.
--
-- A linked, active recipe is what the dish consumes from stock
-- (recipe_components); an unlinked one consumes nothing.

-- 1. A dish ('menu_item') recipe may be unlinked. A 'variant' recipe is
--    by definition linked to a size; batches never point at a product.
do $$
declare c record;
begin
  for c in
    select conname from pg_constraint
     where conrelid = 'public.recipes'::regclass and contype = 'c'
       and pg_get_constraintdef(oid) ilike '%menu_item_id IS NOT NULL%'
  loop
    execute format('alter table public.recipes drop constraint %I', c.conname);
  end loop;
end $$;
alter table public.recipes
  add constraint recipes_batch_unlinked_check check (recipe_type in ('menu_item', 'variant') or menu_item_id is null),
  add constraint recipes_variant_linked_check check (recipe_type <> 'variant' or menu_item_id is not null);

-- 2. Writes (or clears) the stock link for one recipe from its current
--    state: linked + active -> its resolved ingredients; otherwise none.
create or replace function app.sync_recipe_components(p_recipe_id uuid)
returns void language plpgsql security definer set search_path = public, app as $fn$
declare v public.recipes;
begin
  select * into v from public.recipes where id = p_recipe_id;
  if v.id is null or v.menu_item_id is null then return; end if;
  delete from public.recipe_components
   where menu_item_id = v.menu_item_id and variant_id is not distinct from v.variant_id;
  if v.status = 'active' and v.current_version_id is not null then
    insert into public.recipe_components (menu_item_id, variant_id, inventory_item_id, qty_per_unit)
    select v.menu_item_id, v.variant_id, x.inventory_item_id, sum(x.qty_base)
      from public.resolve_recipe_ingredients(v.current_version_id) x
     group by x.inventory_item_id;
  end if;
end;
$fn$;
revoke all on function app.sync_recipe_components(uuid) from public;

-- 3. create_recipe: a dish recipe no longer needs a menu item.
create or replace function public.create_recipe(
  p_name text, p_description text, p_notes text, p_recipe_type app.recipe_type,
  p_menu_item_id uuid, p_variant_id uuid, p_instructions text,
  p_yield_qty numeric, p_yield_unit text, p_ingredients jsonb
) returns table (recipe_id uuid, recipe_version_id uuid, cost_cents int)
language plpgsql security definer set search_path = public, app as $fn$
declare
  v_recipe_id uuid; v_version_id uuid; v_ing jsonb; v_cost int;
begin
  if not (app.has_perm('inventory.manage_recipes') or app.has_perm('finance.manage_recipes')) then
    raise exception 'forbidden' using errcode = 'insufficient_privilege';
  end if;
  if coalesce(trim(p_name), '') = '' then
    raise exception 'recipe_name_required' using errcode = 'check_violation';
  end if;
  if p_ingredients is null or jsonb_typeof(p_ingredients) <> 'array' or jsonb_array_length(p_ingredients) = 0 then
    raise exception 'recipe_needs_ingredients' using errcode = 'check_violation';
  end if;
  if p_recipe_type = 'variant' and (p_menu_item_id is null or p_variant_id is null) then
    raise exception 'recipe_needs_menu_item' using errcode = 'check_violation';
  end if;

  insert into public.recipes (name, description, notes, recipe_type, menu_item_id, variant_id, instructions, status, created_by)
  values (trim(p_name), nullif(trim(coalesce(p_description, '')), ''), nullif(trim(coalesce(p_notes, '')), ''),
          p_recipe_type,
          case when p_recipe_type in ('menu_item', 'variant') then p_menu_item_id end,
          case when p_recipe_type = 'variant' then p_variant_id end,
          nullif(trim(coalesce(p_instructions, '')), ''), 'draft', app.jwt_sub())
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

-- 4. activate_recipe_version: an unlinked dish recipe can be activated
--    (ready to link); it only feeds stock once it is linked.
create or replace function public.activate_recipe_version(p_recipe_version_id uuid)
returns void language plpgsql security definer set search_path = public, app as $fn$
declare
  v_recipe_id uuid; v_recipe public.recipes; v_prev_active uuid; v_cost int;
begin
  if not (app.has_perm('inventory.manage_recipes') or app.has_perm('finance.manage_recipes')) then
    raise exception 'forbidden' using errcode = 'insufficient_privilege';
  end if;

  select recipe_id into v_recipe_id from public.recipe_versions where id = p_recipe_version_id;
  if v_recipe_id is null then raise exception 'recipe_version_not_found' using errcode = 'no_data_found'; end if;
  select * into v_recipe from public.recipes where id = v_recipe_id;

  if not exists (select 1 from public.recipe_ingredients where recipe_version_id = p_recipe_version_id) then
    raise exception 'recipe_needs_ingredients' using errcode = 'check_violation';
  end if;

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

  perform app.sync_recipe_components(v_recipe_id);

  v_cost := public.recipe_version_total_cost(p_recipe_version_id);
  insert into public.recipe_cost_log (recipe_version_id, cost_cents) values (p_recipe_version_id, v_cost);

  perform app.log_action('recipe.activated', 'recipes', v_recipe_id::text,
    jsonb_build_object('previous_version_id', v_prev_active),
    jsonb_build_object('active_version_id', p_recipe_version_id, 'cost_cents', v_cost));
end;
$fn$;
revoke all on function public.activate_recipe_version(uuid) from public;
grant execute on function public.activate_recipe_version(uuid) to authenticated, service_role;

-- 5. Link a dish recipe to a menu item (or one of its sizes).
create or replace function public.link_recipe(p_recipe_id uuid, p_menu_item_id uuid, p_variant_id uuid default null)
returns void language plpgsql security definer set search_path = public, app as $fn$
declare v public.recipes; v_item text; v_other text; v_linked text;
begin
  if not (app.has_perm('inventory.manage_recipes') or app.has_perm('finance.manage_recipes')) then
    raise exception 'forbidden' using errcode = 'insufficient_privilege';
  end if;
  select * into v from public.recipes where id = p_recipe_id;
  if v.id is null then raise exception 'recipe_not_found' using errcode = 'no_data_found'; end if;
  if v.status = 'archived' then
    raise exception 'This recipe is archived. Restore it with a new version first.' using errcode = 'check_violation';
  end if;
  if v.recipe_type not in ('menu_item', 'variant') then
    raise exception '"%" is a batch recipe. Use it as a sub-recipe inside a dish recipe instead.', v.name using errcode = 'check_violation';
  end if;
  select name into v_item from public.menu_items where id = p_menu_item_id;
  if v_item is null then raise exception 'menu_item_not_found' using errcode = 'no_data_found'; end if;
  if p_variant_id is not null and not exists (
    select 1 from public.menu_variants where id = p_variant_id and menu_item_id = p_menu_item_id
  ) then
    raise exception 'variant_not_found' using errcode = 'no_data_found';
  end if;
  if v.menu_item_id is not null then
    if v.menu_item_id = p_menu_item_id and v.variant_id is not distinct from p_variant_id then return; end if;
    select name into v_linked from public.menu_items where id = v.menu_item_id;
    raise exception '"%" is already linked to "%". Unlink it there first.', v.name, v_linked using errcode = 'check_violation';
  end if;
  select r.name into v_other from public.recipes r
   where r.menu_item_id = p_menu_item_id and r.variant_id is not distinct from p_variant_id
     and r.status <> 'archived' and r.id <> p_recipe_id
   limit 1;
  if v_other is not null then
    raise exception '"%" already has a recipe ("%"). Unlink it first.', v_item, v_other using errcode = 'unique_violation';
  end if;

  update public.recipes
     set menu_item_id = p_menu_item_id,
         variant_id = p_variant_id,
         recipe_type = case when p_variant_id is null then 'menu_item' else 'variant' end::app.recipe_type
   where id = p_recipe_id;
  perform app.sync_recipe_components(p_recipe_id);

  perform app.log_action('recipe.linked', 'recipes', p_recipe_id::text, null,
    jsonb_build_object('menu_item_id', p_menu_item_id, 'variant_id', p_variant_id));
end;
$fn$;
revoke all on function public.link_recipe(uuid, uuid, uuid) from public;
grant execute on function public.link_recipe(uuid, uuid, uuid) to authenticated, service_role;

-- 6. Unlink: the dish stops consuming stock; the recipe itself is kept.
create or replace function public.unlink_recipe(p_recipe_id uuid)
returns void language plpgsql security definer set search_path = public, app as $fn$
declare v public.recipes;
begin
  if not (app.has_perm('inventory.manage_recipes') or app.has_perm('finance.manage_recipes')) then
    raise exception 'forbidden' using errcode = 'insufficient_privilege';
  end if;
  select * into v from public.recipes where id = p_recipe_id;
  if v.id is null then raise exception 'recipe_not_found' using errcode = 'no_data_found'; end if;
  if v.menu_item_id is null then return; end if;

  delete from public.recipe_components
   where menu_item_id = v.menu_item_id and variant_id is not distinct from v.variant_id;
  update public.recipes set menu_item_id = null, variant_id = null, recipe_type = 'menu_item' where id = p_recipe_id;

  perform app.log_action('recipe.unlinked', 'recipes', p_recipe_id::text,
    jsonb_build_object('menu_item_id', v.menu_item_id, 'variant_id', v.variant_id), null);
end;
$fn$;
revoke all on function public.unlink_recipe(uuid) from public;
grant execute on function public.unlink_recipe(uuid) to authenticated, service_role;
