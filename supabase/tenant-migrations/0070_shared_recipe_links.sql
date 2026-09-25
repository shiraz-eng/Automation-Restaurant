-- 0070: one recipe can be linked to many dishes / sizes.
--
-- Until now a recipe pointed at ONE dish (recipes.menu_item_id/variant_id).
-- Links now live in recipe_links, so the same recipe (e.g. "Beef Patty")
-- can be picked for any number of dishes or sizes. Each dish / size still
-- has at most ONE recipe, which is what decides its stock deduction.
--
-- recipe_components (what orders deduct) is still per dish/size and is
-- rebuilt for every link of a recipe whenever the recipe changes.
-- Deleting a dish or size deletes only its link; the recipe stays.
-- recipes.menu_item_id/variant_id are no longer used and are cleared.

create table if not exists public.recipe_links (
  id            uuid primary key default gen_random_uuid(),
  recipe_id     uuid not null references public.recipes(id) on delete cascade,
  menu_item_id  uuid not null references public.menu_items(id) on delete cascade,
  variant_id    uuid references public.menu_variants(id) on delete cascade,
  created_at    timestamptz not null default now()
);
create unique index if not exists recipe_links_one_per_product_idx
  on public.recipe_links(menu_item_id, coalesce(variant_id, '00000000-0000-0000-0000-000000000000'::uuid));
create index if not exists recipe_links_recipe_idx on public.recipe_links(recipe_id);

alter table public.recipe_links enable row level security;
drop policy if exists staff_read on public.recipe_links;
create policy staff_read on public.recipe_links for select using (app.has_perm('menu.view') or app.is_staff());
-- Writes only through link_recipe()/unlink_recipe() (security definer).
grant select on public.recipe_links to authenticated;
grant all on public.recipe_links to service_role;

-- Existing links move over; archived recipes keep none.
insert into public.recipe_links (recipe_id, menu_item_id, variant_id)
select r.id, r.menu_item_id, r.variant_id
  from public.recipes r
 where r.menu_item_id is not null and r.status <> 'archived'
on conflict do nothing;

update public.recipes
   set menu_item_id = null, variant_id = null,
       recipe_type = case when recipe_type = 'variant' then 'menu_item'::app.recipe_type else recipe_type end
 where menu_item_id is not null or recipe_type = 'variant';

-- Rebuild every link's stock rows from its recipe's active version.
create or replace function app.sync_recipe_components(p_recipe_id uuid)
returns void language plpgsql security definer set search_path = public, app as $fn$
declare v public.recipes; l record;
begin
  select * into v from public.recipes where id = p_recipe_id;
  if v.id is null then return; end if;
  for l in select menu_item_id, variant_id from public.recipe_links where recipe_id = p_recipe_id loop
    delete from public.recipe_components
     where menu_item_id = l.menu_item_id and variant_id is not distinct from l.variant_id;
    if v.status = 'active' and v.current_version_id is not null then
      insert into public.recipe_components (menu_item_id, variant_id, inventory_item_id, qty_per_unit)
      select l.menu_item_id, l.variant_id, x.inventory_item_id, sum(x.qty_base)
        from public.resolve_recipe_ingredients(v.current_version_id) x
       group by x.inventory_item_id;
    end if;
  end loop;
end;
$fn$;
revoke all on function app.sync_recipe_components(uuid) from public;

-- Removes one link (or every link) and the stock rows it produced.
create or replace function app.drop_recipe_links(p_recipe_id uuid, p_menu_item_id uuid default null, p_variant_id uuid default null, p_all boolean default false)
returns int language plpgsql security definer set search_path = public, app as $fn$
declare l record; n int := 0;
begin
  for l in
    select id, menu_item_id, variant_id from public.recipe_links
     where recipe_id = p_recipe_id
       and (p_all or (menu_item_id = p_menu_item_id and variant_id is not distinct from p_variant_id))
  loop
    delete from public.recipe_components
     where menu_item_id = l.menu_item_id and variant_id is not distinct from l.variant_id;
    delete from public.recipe_links where id = l.id;
    n := n + 1;
  end loop;
  return n;
end;
$fn$;
revoke all on function app.drop_recipe_links(uuid, uuid, uuid, boolean) from public;

-- create_recipe: a dish given at creation (AI chat "draft a recipe for X")
-- becomes a link; the recipe row itself no longer names a dish.
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

  insert into public.recipes (name, description, notes, recipe_type, instructions, status, created_by)
  values (trim(p_name), nullif(trim(coalesce(p_description, '')), ''), nullif(trim(coalesce(p_notes, '')), ''),
          case when p_recipe_type = 'variant' then 'menu_item'::app.recipe_type else p_recipe_type end,
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

  if p_menu_item_id is not null and p_recipe_type in ('menu_item', 'variant') then
    if exists (select 1 from public.recipe_links
                where menu_item_id = p_menu_item_id and variant_id is not distinct from p_variant_id) then
      raise exception 'That dish already has a recipe. Unlink it first.' using errcode = 'unique_violation';
    end if;
    insert into public.recipe_links (recipe_id, menu_item_id, variant_id) values (v_recipe_id, p_menu_item_id, p_variant_id);
  end if;

  v_cost := public.recipe_version_total_cost(v_version_id);
  perform app.log_action('recipe.created', 'recipes', v_recipe_id::text, null,
    jsonb_build_object('name', p_name, 'version_id', v_version_id, 'cost_cents', v_cost));

  return query select v_recipe_id, v_version_id, v_cost;
end;
$fn$;
revoke all on function public.create_recipe(text, text, text, app.recipe_type, uuid, uuid, text, numeric, text, jsonb) from public;
grant execute on function public.create_recipe(text, text, text, app.recipe_type, uuid, uuid, text, numeric, text, jsonb) to authenticated, service_role;

-- link_recipe: any dish recipe can be picked, even one already used by
-- other dishes. Only the target dish/size must not have a different recipe.
create or replace function public.link_recipe(p_recipe_id uuid, p_menu_item_id uuid, p_variant_id uuid default null)
returns void language plpgsql security definer set search_path = public, app as $fn$
declare v public.recipes; v_item text; v_other text; v_version uuid;
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

  if exists (select 1 from public.recipe_links where recipe_id = p_recipe_id
              and menu_item_id = p_menu_item_id and variant_id is not distinct from p_variant_id) then
    return;  -- already linked exactly here
  end if;
  select r.name into v_other
    from public.recipe_links l join public.recipes r on r.id = l.recipe_id
   where l.menu_item_id = p_menu_item_id and l.variant_id is not distinct from p_variant_id;
  if v_other is not null then
    raise exception '"%" already has a recipe ("%"). Unlink it first.', v_item, v_other using errcode = 'unique_violation';
  end if;

  insert into public.recipe_links (recipe_id, menu_item_id, variant_id) values (p_recipe_id, p_menu_item_id, p_variant_id);

  if v.status = 'draft' then
    -- Linking switches the recipe on (and writes every link's stock rows).
    select id into v_version from public.recipe_versions where recipe_id = p_recipe_id order by version desc limit 1;
    if v_version is not null then perform public.activate_recipe_version(v_version); end if;
  else
    perform app.sync_recipe_components(p_recipe_id);
  end if;

  perform app.log_action('recipe.linked', 'recipes', p_recipe_id::text, null,
    jsonb_build_object('menu_item_id', p_menu_item_id, 'variant_id', p_variant_id, 'activated', v.status = 'draft'));
end;
$fn$;
revoke all on function public.link_recipe(uuid, uuid, uuid) from public;
grant execute on function public.link_recipe(uuid, uuid, uuid) to authenticated, service_role;

-- unlink_recipe: from one dish/size, or (no dish given) from all of them.
drop function if exists public.unlink_recipe(uuid);
create or replace function public.unlink_recipe(p_recipe_id uuid, p_menu_item_id uuid default null, p_variant_id uuid default null)
returns void language plpgsql security definer set search_path = public, app as $fn$
declare n int;
begin
  if not (app.has_perm('inventory.manage_recipes') or app.has_perm('finance.manage_recipes')) then
    raise exception 'forbidden' using errcode = 'insufficient_privilege';
  end if;
  if not exists (select 1 from public.recipes where id = p_recipe_id) then
    raise exception 'recipe_not_found' using errcode = 'no_data_found';
  end if;
  n := app.drop_recipe_links(p_recipe_id, p_menu_item_id, p_variant_id, p_menu_item_id is null);
  if n > 0 then
    perform app.log_action('recipe.unlinked', 'recipes', p_recipe_id::text,
      jsonb_build_object('menu_item_id', p_menu_item_id, 'variant_id', p_variant_id, 'links_removed', n), null);
  end if;
end;
$fn$;
revoke all on function public.unlink_recipe(uuid, uuid, uuid) from public;
grant execute on function public.unlink_recipe(uuid, uuid, uuid) to authenticated, service_role;

-- archive_recipe: an archived recipe feeds no dish; its links are removed.
create or replace function public.archive_recipe(p_recipe_id uuid)
returns void language plpgsql security definer set search_path = public, app as $fn$
begin
  if not (app.has_perm('inventory.manage_recipes') or app.has_perm('finance.manage_recipes')) then
    raise exception 'forbidden' using errcode = 'insufficient_privilege';
  end if;
  if not exists (select 1 from public.recipes where id = p_recipe_id) then
    raise exception 'recipe_not_found' using errcode = 'no_data_found';
  end if;
  update public.recipes set status = 'archived' where id = p_recipe_id;
  update public.recipe_versions set status = 'archived', effective_to = coalesce(effective_to, now())
   where recipe_id = p_recipe_id and status = 'active';
  perform app.drop_recipe_links(p_recipe_id, null, null, true);
  perform app.log_action('recipe.archived', 'recipes', p_recipe_id::text, null, null);
end;
$fn$;
revoke all on function public.archive_recipe(uuid) from public;
grant execute on function public.archive_recipe(uuid) to authenticated, service_role;

-- delete_recipe: same checks as 0067; clears every link's stock rows first.
create or replace function public.delete_recipe(p_recipe_id uuid)
returns void language plpgsql security definer set search_path = public, app as $fn$
declare v_recipe public.recipes; v_users text;
begin
  if not (app.has_perm('inventory.manage_recipes') or app.has_perm('finance.manage_recipes')) then
    raise exception 'forbidden' using errcode = 'insufficient_privilege';
  end if;
  select * into v_recipe from public.recipes where id = p_recipe_id;
  if v_recipe.id is null then raise exception 'recipe_not_found' using errcode = 'no_data_found'; end if;

  select string_agg(distinct r.name, ', ' order by r.name) into v_users
    from public.recipe_ingredients ri
    join public.recipe_versions rv on rv.id = ri.recipe_version_id
    join public.recipes r on r.id = rv.recipe_id
   where ri.sub_recipe_id = p_recipe_id and r.id <> p_recipe_id;
  if v_users is not null then
    raise exception 'This recipe is used as a sub-recipe in: %. Remove it from those recipes first.', v_users
      using errcode = 'foreign_key_violation';
  end if;

  perform app.drop_recipe_links(p_recipe_id, null, null, true);
  perform app.log_action('recipe.deleted', 'recipes', p_recipe_id::text,
                         jsonb_build_object('name', v_recipe.name, 'status', v_recipe.status, 'recipe_type', v_recipe.recipe_type),
                         null);
  delete from public.recipes where id = p_recipe_id;
end;
$fn$;
revoke all on function public.delete_recipe(uuid) from public;
grant execute on function public.delete_recipe(uuid) to authenticated, service_role;
