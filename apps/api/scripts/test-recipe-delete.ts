// Recipe delete tests (tenant migration 0067).
//
// Same approach as test-deals.ts: one DO block against a real tenant that
// builds a fixture, calls the real RPC and ends by raising an exception so
// everything rolls back.
//
// Usage (from apps/api):  npx tsx scripts/test-recipe-delete.ts [project_ref]
import { supabaseAdmin } from '../src/supabase';
import { getFreshConnection } from '../src/lib/supabaseOAuth';
import { env } from '../src/env';

const REF = process.argv[2] ?? 'uhfwoftjecgjemvwqdbp';

const SQL = String.raw`
do $$
declare
  res text := '';
  fails int := 0;
  v_ing uuid; v_item uuid; v_draft uuid; v_menu uuid; v_sub uuid; v_parent uuid; v_n int;
begin
  perform set_config('request.jwt.claims',
    '{"role":"authenticated","sub":"00000000-0000-0000-0000-00000000f00d","app_metadata":{"role":"owner","permissions":["*"]}}', true);

  insert into public.inventory_items (name, unit, stock_qty, min_threshold, cost_cents_per_base_unit)
    values ('ZZ Flour', 'g', 5000, 0, 1) returning id into v_ing;
  insert into public.menu_items (name, price_cents, is_available) values ('ZZ Naan', 0, true) returning id into v_item;
  insert into public.menu_variants (menu_item_id, name, price_cents, sort_order) values (v_item, 'Regular', 100, 0);

  -- R1. A draft recipe is removed with its versions and ingredients.
  select recipe_id into v_draft from public.create_recipe('ZZ Draft', null, null, 'preparation', null, null, null, 1, 'g',
    jsonb_build_array(jsonb_build_object('inventory_item_id', v_ing, 'qty_base', 10)));
  perform public.delete_recipe(v_draft);
  select count(*) into v_n from public.recipe_versions where recipe_id = v_draft;
  if not exists (select 1 from public.recipes where id = v_draft) and v_n = 0 then res := res || E'PASS R1 draft recipe and its versions deleted\n';
  else fails := fails + 1; res := res || E'FAIL R1 draft recipe not fully deleted\n'; end if;

  -- R2. Deleting an active menu recipe stops the dish consuming stock.
  select recipe_id into v_menu from public.create_recipe('ZZ Naan', null, null, 'menu_item', v_item, null, null, 1, null,
    jsonb_build_array(jsonb_build_object('inventory_item_id', v_ing, 'qty_base', 120)));
  perform public.activate_recipe_version((select id from public.recipe_versions where recipe_id = v_menu order by version desc limit 1));
  select count(*) into v_n from public.recipe_components where menu_item_id = v_item;
  if v_n = 0 then fails := fails + 1; res := res || E'FAIL R2 setup: activation wrote no recipe_components\n'; end if;
  perform public.delete_recipe(v_menu);
  select count(*) into v_n from public.recipe_components where menu_item_id = v_item;
  if v_n = 0 and not exists (select 1 from public.recipes where id = v_menu) then res := res || E'PASS R2 active menu recipe deleted, dish no longer consumes stock\n';
  else fails := fails + 1; res := res || E'FAIL R2 recipe_components left behind: ' || v_n || E'\n'; end if;

  -- R3. A sub-recipe still used elsewhere is refused with the user's name.
  select recipe_id into v_sub from public.create_recipe('ZZ Dough', null, null, 'semi_finished', null, null, null, 1000, 'g',
    jsonb_build_array(jsonb_build_object('inventory_item_id', v_ing, 'qty_base', 900)));
  perform public.activate_recipe_version((select id from public.recipe_versions where recipe_id = v_sub order by version desc limit 1));
  select recipe_id into v_parent from public.create_recipe('ZZ Garlic Naan', null, null, 'preparation', null, null, null, 1, null,
    jsonb_build_array(jsonb_build_object('sub_recipe_id', v_sub, 'qty_base', 150)));
  begin
    perform public.delete_recipe(v_sub);
    fails := fails + 1; res := res || E'FAIL R3 in-use sub-recipe was deleted\n';
  exception when foreign_key_violation then
    if sqlerrm like '%ZZ Garlic Naan%' then res := res || E'PASS R3 in-use sub-recipe refused: ' || sqlerrm || E'\n';
    else fails := fails + 1; res := res || E'FAIL R3 message missing parent name: ' || sqlerrm || E'\n'; end if;
  end;

  -- R4. Once the parent is gone the sub-recipe can be deleted.
  perform public.delete_recipe(v_parent);
  perform public.delete_recipe(v_sub);
  if not exists (select 1 from public.recipes where id in (v_sub, v_parent)) then res := res || E'PASS R4 sub-recipe deletable after its user is removed\n';
  else fails := fails + 1; res := res || E'FAIL R4 sub-recipe still present\n'; end if;

  -- R5. A portal without a recipe-management permission is refused.
  select recipe_id into v_draft from public.create_recipe('ZZ Guarded', null, null, 'preparation', null, null, null, 1, 'g',
    jsonb_build_array(jsonb_build_object('inventory_item_id', v_ing, 'qty_base', 5)));
  perform set_config('request.jwt.claims',
    '{"role":"authenticated","sub":"00000000-0000-0000-0000-00000000beef","app_metadata":{"kind":"portal","portal_id":"11111111-1111-1111-1111-111111111111","permissions":["menu.view"]}}', true);
  begin
    perform public.delete_recipe(v_draft);
    fails := fails + 1; res := res || E'FAIL R5 portal without manage_recipes deleted a recipe\n';
  exception
    when insufficient_privilege then res := res || E'PASS R5 portal without manage_recipes refused\n';
    when others then fails := fails + 1; res := res || 'FAIL R5 unexpected: ' || sqlerrm || E'\n';
  end;

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
