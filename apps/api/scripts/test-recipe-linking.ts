// Recipe linking tests (tenant migrations 0068-0070).
//
// Same approach as test-deals.ts: one DO block against a real tenant that
// builds a fixture, calls the real RPCs and ends by raising an exception so
// everything rolls back.
//
// Usage (from apps/api):  npx tsx scripts/test-recipe-linking.ts [project_ref]
import { supabaseAdmin } from '../src/supabase';
import { getFreshConnection } from '../src/lib/supabaseOAuth';
import { env } from '../src/env';

const REF = process.argv[2] ?? 'uhfwoftjecgjemvwqdbp';

const SQL = String.raw`
do $$
declare
  res text := ''; fails int := 0;
  v_ing uuid; v_item uuid; v_item2 uuid; v_var uuid; v_r1 uuid; v_r2 uuid; v_batch uuid; v_vid uuid;
  v_n int; v_q numeric; v_s text;
begin
  perform set_config('request.jwt.claims',
    '{"role":"authenticated","sub":"00000000-0000-0000-0000-00000000f00d","app_metadata":{"role":"owner","permissions":["*"]}}', true);
  insert into public.inventory_items (name, unit, stock_qty, min_threshold, cost_cents_per_base_unit)
    values ('ZZ Beef', 'g', 8000, 0, 3) returning id into v_ing;
  insert into public.menu_items (name, price_cents, is_available) values ('ZZ Smash Burger', 0, true) returning id into v_item;
  insert into public.menu_variants (menu_item_id, name, price_cents, sort_order) values (v_item, 'Single', 700, 0);
  insert into public.menu_variants (menu_item_id, name, price_cents, sort_order) values (v_item, 'Double', 950, 1) returning id into v_var;
  insert into public.menu_items (name, price_cents, is_available) values ('ZZ Patty Melt', 0, true) returning id into v_item2;
  insert into public.menu_variants (menu_item_id, name, price_cents, sort_order) values (v_item2, 'Regular', 600, 0);

  -- L1 a dish recipe exists on its own and consumes nothing
  select recipe_id, recipe_version_id into v_r1, v_vid from public.create_recipe('ZZ Beef Patty', null, null, 'menu_item', null, null, null, 1, null,
    jsonb_build_array(jsonb_build_object('inventory_item_id', v_ing, 'qty_base', 150)));
  perform public.activate_recipe_version(v_vid);
  select count(*) into v_n from public.recipe_components where inventory_item_id = v_ing;
  if v_n = 0 and not exists (select 1 from public.recipe_links where recipe_id = v_r1) then res := res || E'PASS L1 unlinked recipe consumes nothing\n';
  else fails := fails + 1; res := res || E'FAIL L1 unlinked recipe consuming\n'; end if;

  -- L2 the SAME recipe linked to two dishes: both consume it
  perform public.link_recipe(v_r1, v_item, null);
  perform public.link_recipe(v_r1, v_item2, null);
  select count(*) into v_n from public.recipe_components where inventory_item_id = v_ing and qty_per_unit = 150 and menu_item_id in (v_item, v_item2);
  if v_n = 2 then res := res || E'PASS L2 one recipe shared by two dishes, both consume 150 g\n';
  else fails := fails + 1; res := res || 'FAIL L2 components ' || v_n || E'\n'; end if;

  -- L3 a dish already on a recipe refuses a different one
  select recipe_id into v_r2 from public.create_recipe('ZZ Thin Patty', null, null, 'menu_item', null, null, null, 1, null,
    jsonb_build_array(jsonb_build_object('inventory_item_id', v_ing, 'qty_base', 90)));
  begin
    perform public.link_recipe(v_r2, v_item, null);
    fails := fails + 1; res := res || E'FAIL L3 dish got two recipes\n';
  exception when unique_violation then res := res || 'PASS L3 refused: ' || sqlerrm || E'\n'; end;

  -- L4 a draft linked to one size is activated and feeds only that size
  perform public.link_recipe(v_r2, v_item, v_var);
  select status::text into v_s from public.recipes where id = v_r2;
  select sum(qty_per_unit) into v_q from public.recipe_components where menu_item_id = v_item and variant_id = v_var;
  if v_s = 'active' and v_q = 90 then res := res || E'PASS L4 draft linked to the Double size: activated, 90 g\n';
  else fails := fails + 1; res := res || 'FAIL L4 status ' || v_s || ' qty ' || coalesce(v_q::text, 'none') || E'\n'; end if;

  -- L5 a new version of a shared recipe updates every dish it is linked to
  select recipe_version_id into v_vid from public.create_recipe_version(v_r1,
    jsonb_build_array(jsonb_build_object('inventory_item_id', v_ing, 'qty_base', 160)), null, null);
  perform public.activate_recipe_version(v_vid);
  select count(*) into v_n from public.recipe_components where inventory_item_id = v_ing and qty_per_unit = 160 and variant_id is null and menu_item_id in (v_item, v_item2);
  if v_n = 2 then res := res || E'PASS L5 new version of the shared recipe reaches both dishes (160 g)\n';
  else fails := fails + 1; res := res || 'FAIL L5 updated components ' || v_n || E'\n'; end if;

  -- L6 unlink from ONE dish: the other dish keeps it
  perform public.unlink_recipe(v_r1, v_item2, null);
  if not exists (select 1 from public.recipe_components where menu_item_id = v_item2)
     and exists (select 1 from public.recipe_components where menu_item_id = v_item and variant_id is null) then
    res := res || E'PASS L6 unlinked from one dish only; the other keeps it\n';
  else fails := fails + 1; res := res || E'FAIL L6 unlink scope\n'; end if;

  -- L7 a batch recipe can't be linked to a dish
  select recipe_id into v_batch from public.create_recipe('ZZ Burger Sauce', null, null, 'preparation', null, null, null, 1000, 'ml',
    jsonb_build_array(jsonb_build_object('inventory_item_id', v_ing, 'qty_base', 10)));
  begin
    perform public.link_recipe(v_batch, v_item2, null);
    fails := fails + 1; res := res || E'FAIL L7 batch linked to a dish\n';
  exception when check_violation then res := res || 'PASS L7 refused: ' || sqlerrm || E'\n'; end;

  -- L9 deleting a size keeps its recipe
  delete from public.menu_variants where id = v_var;
  if exists (select 1 from public.recipes where id = v_r2) and not exists (select 1 from public.recipe_links where recipe_id = v_r2) then
    res := res || E'PASS L9 size deleted: its recipe survives, unlinked\n';
  else fails := fails + 1; res := res || E'FAIL L9\n'; end if;

  -- L10 deleting a dish keeps the (shared) recipe
  delete from public.menu_items where id = v_item;
  if exists (select 1 from public.recipes where id = v_r1) and not exists (select 1 from public.recipe_components where menu_item_id = v_item) then
    res := res || E'PASS L10 dish deleted: the recipe survives, ready to link again\n';
  else fails := fails + 1; res := res || E'FAIL L10\n'; end if;

  -- L11 unlink with no dish removes every link of the recipe
  perform public.link_recipe(v_r1, v_item2, null);
  perform public.unlink_recipe(v_r1);
  if not exists (select 1 from public.recipe_links where recipe_id = v_r1) and not exists (select 1 from public.recipe_components where menu_item_id = v_item2) then
    res := res || E'PASS L11 unlink from everywhere\n';
  else fails := fails + 1; res := res || E'FAIL L11\n'; end if;

  -- L8 a portal without recipe permission can't link
  perform set_config('request.jwt.claims',
    '{"role":"authenticated","sub":"00000000-0000-0000-0000-00000000beef","app_metadata":{"kind":"portal","portal_id":"11111111-1111-1111-1111-111111111111","permissions":["menu.view","menu.update"]}}', true);
  begin
    perform public.link_recipe(v_r1, v_item2, null);
    fails := fails + 1; res := res || E'FAIL L8 portal without manage_recipes linked a recipe\n';
  exception when insufficient_privilege then res := res || E'PASS L8 portal without manage_recipes refused\n'; end;

  raise exception E'RESULTS (rolled back) — % failed\n%', fails, res;
end $$;
`;

async function main() {
  const { data: proj } = await supabaseAdmin.from('tenant_projects').select('tenant_id').eq('project_ref', REF).single();
  const { data: conns } = await supabaseAdmin.from('supabase_connections').select('tenant_id').eq('tenant_id', proj!.tenant_id);
  const token = conns && conns.length ? (await getFreshConnection(proj!.tenant_id)).access_token : env.SUPABASE_ACCESS_TOKEN;
  const r = await fetch(`https://api.supabase.com/v1/projects/${REF}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: SQL }),
  });
  const text = await r.text();
  const m = text.match(/RESULTS \(rolled back\) — (\d+) failed\\n([\s\S]*?)"}/);
  if (!m) {
    console.error(text.slice(0, 1500));
    process.exitCode = 1;
    return;
  }
  console.log(m[2].replace(/\\n/g, '\n').replace(/\\"/g, '"'));
  console.log(`${m[1]} failed`);
  if (m[1] !== '0') process.exitCode = 1;
}
main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
