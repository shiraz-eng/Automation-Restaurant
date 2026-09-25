-- 0069: recipes outlive the dishes they are linked to; linking turns them on.
--
-- 1. recipes.menu_item_id / variant_id were ON DELETE CASCADE, so deleting
--    a dish (or one of its sizes) silently deleted its recipe too. A recipe
--    is created first and stands on its own, so deleting the dish now just
--    UNLINKS it: the recipe stays on the Recipes page, ready to link again.
--    (The dish's stock link, recipe_components, still goes with the dish.)
-- 2. link_recipe() activates a draft recipe as it links it, so linking a
--    recipe to a dish immediately switches on stock deduction, food cost
--    and automatic availability.

do $$
declare c record;
begin
  for c in
    select conname from pg_constraint
     where conrelid = 'public.recipes'::regclass and contype = 'f'
       and confrelid in ('public.menu_items'::regclass, 'public.menu_variants'::regclass)
  loop
    execute format('alter table public.recipes drop constraint %I', c.conname);
  end loop;
end $$;
alter table public.recipes
  add constraint recipes_menu_item_id_fkey foreign key (menu_item_id) references public.menu_items(id) on delete set null,
  add constraint recipes_variant_id_fkey foreign key (variant_id) references public.menu_variants(id) on delete set null;

-- Keeps a recipe consistent when its dish or size disappears (the SET NULL
-- above arrives here as an UPDATE): losing the dish, or losing the one size
-- a size-specific recipe was for, leaves a plain unlinked dish recipe.
create or replace function app.recipes_normalize_link() returns trigger
language plpgsql as $fn$
begin
  if new.recipe_type = 'variant' and new.variant_id is null then
    new.menu_item_id := null;
  end if;
  if new.menu_item_id is null then
    new.variant_id := null;
    if new.recipe_type = 'variant' then new.recipe_type := 'menu_item'; end if;
  end if;
  return new;
end;
$fn$;
drop trigger if exists recipes_normalize_link on public.recipes;
create trigger recipes_normalize_link before update on public.recipes
  for each row execute function app.recipes_normalize_link();

create or replace function public.link_recipe(p_recipe_id uuid, p_menu_item_id uuid, p_variant_id uuid default null)
returns void language plpgsql security definer set search_path = public, app as $fn$
declare v public.recipes; v_item text; v_other text; v_linked text; v_version uuid;
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

  if v.status = 'draft' then
    -- Linking switches the recipe on: activate its latest version (this
    -- also writes the dish's stock link and logs the cost).
    select id into v_version from public.recipe_versions where recipe_id = p_recipe_id order by version desc limit 1;
    if v_version is not null then
      perform public.activate_recipe_version(v_version);
    end if;
  else
    perform app.sync_recipe_components(p_recipe_id);
  end if;

  perform app.log_action('recipe.linked', 'recipes', p_recipe_id::text, null,
    jsonb_build_object('menu_item_id', p_menu_item_id, 'variant_id', p_variant_id, 'activated', v.status = 'draft'));
end;
$fn$;
revoke all on function public.link_recipe(uuid, uuid, uuid) from public;
grant execute on function public.link_recipe(uuid, uuid, uuid) to authenticated, service_role;
