-- 0067: permanently delete a recipe (Recipes page "Delete").
--
-- Archive keeps a recipe and its history; Delete removes it with all of
-- its versions, ingredients and cost history (cascades). Past orders are
-- unaffected — they keep their own cost snapshot, not a link to the recipe.
--
-- Refused while another recipe uses it as a sub-recipe (the
-- recipe_ingredients.sub_recipe_id FK is ON DELETE RESTRICT); the error
-- names those recipes so the person knows what to change first.

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

  -- An active menu recipe is what the dish consumes from stock; removing
  -- those rows also recalculates food availability (recipe_components trigger).
  if v_recipe.status = 'active' and v_recipe.recipe_type in ('menu_item', 'variant') then
    delete from public.recipe_components
     where menu_item_id = v_recipe.menu_item_id and variant_id is not distinct from v_recipe.variant_id;
  end if;

  perform app.log_action('recipe.deleted', 'recipes', p_recipe_id::text,
                         jsonb_build_object('name', v_recipe.name, 'status', v_recipe.status, 'recipe_type', v_recipe.recipe_type),
                         null);
  delete from public.recipes where id = p_recipe_id;
end;
$fn$;
revoke all on function public.delete_recipe(uuid) from public;
grant execute on function public.delete_recipe(uuid) to authenticated, service_role;
