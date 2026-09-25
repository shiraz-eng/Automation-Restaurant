// Manual recipe linking tests (tenant migration 0068).
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
  v_ing uuid; v_item uuid; v_item2 uuid; v_var uuid; v_r1 uuid; v_r2 uuid; v_r3 uuid; v_batch uuid; v_vid uuid;
  v_n int; v_q numeric; v_t text; v_s text; v_m uuid; v_var2 uuid;
begin
  perform set_config('request.jwt.claims',
    '{"role":"authenticated","sub":"00000000-0000-0000-0000-00000000f00d","app_metadata":{"role":"owner","permissions":["*"]}}', true);
  insert into public.inventory_items (name, unit, stock_qty, min_threshold, cost_cents_per_base_unit)
    values ('ZZ Beef', 'g', 8000, 0, 3) returning id into v_ing;
  insert into public.menu_items (name, price_cents, is_available) values ('ZZ Smash Burger', 0, true) returning id into v_item;
  insert into public.menu_variants (menu_item_id, name, price_cents, sort_order) values (v_item, 'Single', 700, 0);
  insert into public.menu_variants (menu_item_id, name, price_cents, sort_order) values (v_item, 'Double', 950, 1) returning id into v_var;
  insert into public.menu_items (name, price_cents, is_available) values ('ZZ Other Burger', 0, true) returning id into v_item2;
  insert into public.menu_variants (menu_item_id, name, price_cents, sort_order) values (v_item2, 'Regular', 600, 0);

  -- L1 a dish recipe is created and activated without any menu item
  select recipe_id, recipe_version_id into v_r1, v_vid from public.create_recipe('ZZ Smash Patty', null, null, 'menu_item', null, null, null, 1, null,
    jsonb_build_array(jsonb_build_object('inventory_item_id', v_ing, 'qty_base', 150)));
  perform public.activate_recipe_version(v_vid);
  select menu_item_id into v_m from public.recipes where id = v_r1;
  select count(*) into v_n from public.recipe_components where inventory_item_id = v_ing;
  if v_m is null and v_n = 0 then res := res || E'PASS L1 unlinked recipe created + activated, consumes nothing\n';
  else fails := fails + 1; res := res || E'FAIL L1 linked/consuming without a link\n'; end if;

  -- L2 linking it makes the dish consume stock
  perform public.link_recipe(v_r1, v_item, null);
  select sum(qty_per_unit) into v_q from public.recipe_components where menu_item_id = v_item and variant_id is null;
  if v_q = 150 then res := res || E'PASS L2 linked dish consumes 150 g per serving\n';
  else fails := fails + 1; res := res || 'FAIL L2 components ' || coalesce(v_q::text, 'none') || E'\n'; end if;

  -- L3 a linked recipe can't be linked to a second dish
  begin
    perform public.link_recipe(v_r1, v_item2, null);
    fails := fails + 1; res := res || E'FAIL L3 recipe linked to two dishes\n';
  exception when check_violation then res := res || 'PASS L3 refused: ' || sqlerrm || E'\n'; end;

  -- L4 a dish that already has a recipe refuses a second one
  select recipe_id into v_r2 from public.create_recipe('ZZ Alt Patty', null, null, 'menu_item', null, null, null, 1, null,
    jsonb_build_array(jsonb_build_object('inventory_item_id', v_ing, 'qty_base', 120)));
  begin
    perform public.link_recipe(v_r2, v_item, null);
    fails := fails + 1; res := res || E'FAIL L4 dish got two recipes\n';
  exception when unique_violation then res := res || 'PASS L4 refused: ' || sqlerrm || E'\n'; end;

  -- L5 unlink: stock link removed, recipe kept
  perform public.unlink_recipe(v_r1);
  select count(*) into v_n from public.recipe_components where menu_item_id = v_item;
  select menu_item_id into v_m from public.recipes where id = v_r1;
  if v_n = 0 and v_m is null and exists (select 1 from public.recipes where id = v_r1 and status = 'active') then
    res := res || E'PASS L5 unlinked: dish consumes nothing, recipe kept active\n';
  else fails := fails + 1; res := res || E'FAIL L5 unlink\n'; end if;

  -- L6 linking a DRAFT to one size activates it (0069): stock + cost switch on
  perform public.link_recipe(v_r2, v_item, v_var);
  select recipe_type::text, status::text into v_t, v_s from public.recipes where id = v_r2;
  select sum(qty_per_unit) into v_q from public.recipe_components where menu_item_id = v_item and variant_id = v_var;
  if v_t = 'variant' and v_s = 'active' and v_q = 120 then res := res || E'PASS L6 draft linked to the Double size is activated and consumes 120 g\n';
  else fails := fails + 1; res := res || 'FAIL L6 type ' || v_t || ' status ' || v_s || ' components ' || coalesce(v_q::text, 'none') || E'\n'; end if;

  -- L7 a batch recipe can't be linked to a dish
  select recipe_id into v_batch from public.create_recipe('ZZ Burger Sauce', null, null, 'preparation', null, null, null, 1000, 'ml',
    jsonb_build_array(jsonb_build_object('inventory_item_id', v_ing, 'qty_base', 10)));
  begin
    perform public.link_recipe(v_batch, v_item2, null);
    fails := fails + 1; res := res || E'FAIL L7 batch linked to a dish\n';
  exception when check_violation then res := res || 'PASS L7 refused: ' || sqlerrm || E'\n'; end;

  -- L9 deleting a size keeps its recipe (unlinked) instead of deleting it
  delete from public.menu_variants where id = v_var;
  select menu_item_id, variant_id, recipe_type::text into v_m, v_var2, v_t from public.recipes where id = v_r2;
  if found and v_m is null and v_var2 is null and v_t = 'menu_item' then res := res || E'PASS L9 size deleted: its recipe survives, unlinked\n';
  else fails := fails + 1; res := res || 'FAIL L9 recipe after size delete: item ' || coalesce(v_m::text, 'null') || E'\n'; end if;

  -- L10 deleting the dish keeps its recipe (unlinked) instead of deleting it
  perform public.link_recipe(v_r1, v_item2, null);
  delete from public.menu_items where id = v_item2;
  select menu_item_id into v_m from public.recipes where id = v_r1;
  if found and v_m is null and not exists (select 1 from public.recipe_components where menu_item_id = v_item2) then
    res := res || E'PASS L10 dish deleted: its recipe survives, unlinked, ready to link again\n';
  else fails := fails + 1; res := res || E'FAIL L10 recipe deleted with its dish\n'; end if;

  -- L8 a portal without recipe permission can't link or unlink
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
