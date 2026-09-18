-- 0042: Owner/Manager portal separation — closes the gap where "manager"
-- was an unconditional bypass on ~25 finance/recipe/role RLS
-- policies (app.can_write()/app.is_staff() don't look at the
-- permissions array at all, only the role name), which made the
-- Owner's Portal & Access Control configuration meaningless for those
-- specific tables. Deliberately narrow: only the named finance/
-- recipe-cost/roles tables below lose the can_write()/is_staff()
-- fallback — every other can_write()/is_staff() usage in the schema
-- (orders, kitchen, menu, tables, suppliers, purchasing as a
-- Manager-default domain, deals, staff, attendance, social, ...) is
-- untouched, since Manager is meant to keep that access by default.
-- Idempotent: safe to re-run.

-- ── payments / refunds (financial reads) ────────────────────────────────
drop policy if exists staff_read on public.payments;
create policy staff_read on public.payments for select using (app.has_perm('payments.view'));

drop policy if exists staff_read on public.refunds;
create policy staff_read on public.refunds for select using (app.has_perm('payments.view'));

-- ── business_settings (includes the refund-approval-threshold policy) ──
drop policy if exists mgr_write on public.business_settings;
create policy mgr_write on public.business_settings for all using (app.has_perm('settings.update')) with check (app.has_perm('settings.update'));

-- ── expenses ─────────────────────────────────────────────────────────
drop policy if exists staff_read on public.expenses;
create policy staff_read on public.expenses for select using (app.has_perm('finance.view'));
drop policy if exists staff_insert on public.expenses;
create policy staff_insert on public.expenses for insert with check (app.has_perm('finance.create_expense'));
drop policy if exists staff_update on public.expenses;
create policy staff_update on public.expenses for update using (app.has_perm('finance.update_expense')) with check (app.has_perm('finance.update_expense'));
drop policy if exists staff_delete on public.expenses;
create policy staff_delete on public.expenses for delete using (app.has_perm('finance.delete_expense'));

-- ── Recipes & Food Cost (opt-in domain, spec: "where granted") ─────────
drop policy if exists staff_read on public.recipe_cost_log;
create policy staff_read on public.recipe_cost_log for select using (app.has_perm('inventory.view_cost'));

drop policy if exists mgr_write on public.recipes;
create policy mgr_write on public.recipes for all
  using (app.has_perm('inventory.manage_recipes') or app.has_perm('finance.manage_recipes'))
  with check (app.has_perm('inventory.manage_recipes') or app.has_perm('finance.manage_recipes'));

drop policy if exists mgr_write on public.recipe_versions;
create policy mgr_write on public.recipe_versions for all
  using (app.has_perm('inventory.manage_recipes') or app.has_perm('finance.manage_recipes'))
  with check (app.has_perm('inventory.manage_recipes') or app.has_perm('finance.manage_recipes'));

drop policy if exists mgr_write on public.recipe_ingredients;
create policy mgr_write on public.recipe_ingredients for all
  using (app.has_perm('inventory.manage_recipes') or app.has_perm('finance.manage_recipes'))
  with check (app.has_perm('inventory.manage_recipes') or app.has_perm('finance.manage_recipes'));

drop policy if exists staff_read on public.recipe_import_drafts;
create policy staff_read on public.recipe_import_drafts for select
  using (app.has_perm('inventory.manage_recipes') or app.has_perm('finance.manage_recipes'));
drop policy if exists mgr_write on public.recipe_import_drafts;
create policy mgr_write on public.recipe_import_drafts for all
  using (app.has_perm('inventory.manage_recipes') or app.has_perm('finance.manage_recipes'))
  with check (app.has_perm('inventory.manage_recipes') or app.has_perm('finance.manage_recipes'));

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

create or replace function public.create_recipe_version(
  p_recipe_id uuid, p_ingredients jsonb, p_yield_qty numeric default null, p_yield_unit text default null
) returns table (recipe_version_id uuid, cost_cents int)
language plpgsql security definer set search_path = public, app as $fn$
declare
  v_next_version int; v_version_id uuid; v_ing jsonb; v_cost int;
  v_prev_yield_qty numeric; v_prev_yield_unit text;
begin
  if not (app.has_perm('inventory.manage_recipes') or app.has_perm('finance.manage_recipes')) then
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
  if v_recipe.recipe_type in ('menu_item', 'variant') and v_recipe.menu_item_id is null then
    raise exception 'recipe_needs_menu_item' using errcode = 'check_violation';
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

create or replace function public.archive_recipe(p_recipe_id uuid)
returns void language plpgsql security definer set search_path = public, app as $fn$
declare v_recipe public.recipes;
begin
  if not (app.has_perm('inventory.manage_recipes') or app.has_perm('finance.manage_recipes')) then
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

-- ── public.roles: the privilege-escalation fix ──────────────────────────
-- Before this, ANY manager (role check only, ignoring the permissions
-- array) could write to public.roles directly — including editing their
-- OWN role's permissions array to add anything, bypassing
-- routes/staff.ts's /api/staff/access anti-escalation check entirely
-- (that check only guards the API route, not a direct table write).
drop policy if exists mgr_write on public.roles;
create policy mgr_write on public.roles for all using (app.has_perm('roles.update')) with check (app.has_perm('roles.update'));

-- '*' (unconditional full access) may only ever live on the 'owner' row,
-- even for a caller who does legitimately hold roles.update — the
-- server-side backstop for "Owner-only capabilities cannot be granted
-- through Manager portal configuration".
create or replace function app.protect_owner_only_permissions() returns trigger
language plpgsql as $$
begin
  if new.key <> 'owner' and '*' = any(new.permissions) then
    raise exception 'only the owner role may hold unrestricted (*) access' using errcode = 'insufficient_privilege';
  end if;
  return new;
end $$;
drop trigger if exists protect_owner_only_permissions on public.roles;
create trigger protect_owner_only_permissions before insert or update on public.roles
  for each row execute function app.protect_owner_only_permissions();
