// Rehearsal of the one-time copy a new branch starts with (lib/branchTenants.ts buildSeedSql):
// reads the SOURCE restaurant's menu, recipes, ingredients, suppliers and settings, runs the
// copy inside a transaction on the TARGET restaurant's database, checks every row arrived with
// its links intact and stock at 0, then ROLLS BACK — nothing changes in either restaurant.
//   npx tsx scripts/test-branch-seed.ts <source-slug> <target-project-ref>
import { supabaseAdmin } from '../src/supabase';
import { getFreshConnection, hasConnection } from '../src/lib/supabaseOAuth';
import { env } from '../src/env';
import { buildSeedSql, readSeedData, SEED_TABLES } from '../src/lib/branchTenants';
import { resolveTenantClient } from '../src/lib/tenantAdmin';

const SOURCE = process.argv[2] ?? 'bbq-tonight';
const TARGET = process.argv[3] ?? 'iwccsyjuplkwaxswpgyw';

async function main() {
  const data = await readSeedData(SOURCE);
  const r = await resolveTenantClient(SOURCE);
  if (!r.ok) throw new Error('source not reachable');
  const { data: recipes } = await r.client.admin.from('recipes').select('id, current_version_id');
  data.rows.recipes_original = (recipes ?? []) as Record<string, unknown>[];

  const counts = SEED_TABLES.map((c) => {
    const ids = (data.rows[c.table] ?? []).map((x) => `'${String(x.id)}'`);
    return { table: c.table, expected: ids.length, sql: ids.length ? `(select count(*) from public.${c.table} where id in (${ids.join(',')}))` : '0' };
  });
  const checks = [
    ...counts.map((c) => `'${c.table}', json_build_array(${c.expected}, ${c.sql})`),
    `'stock_all_zero', json_build_array(1, (select case when count(*) filter (where stock_qty <> 0) = 0 then 1 else 0 end from public.inventory_items where id in (${(data.rows.inventory_items ?? []).map((x) => `'${String(x.id)}'`).join(',') || 'null'})))`,
    `'recipes_linked', json_build_array(${(data.rows.recipes_original ?? []).filter((x) => x.current_version_id).length}, (select count(*) from public.recipes where current_version_id is not null and id in (${(data.rows.recipes_original ?? []).map((x) => `'${String(x.id)}'`).join(',') || 'null'})))`,
    // No dish deducts the same ingredient twice.
    `'no_double_deduction', json_build_array(0, (select count(*) from (select menu_item_id, variant_id, inventory_item_id from public.recipe_components group by 1, 2, 3 having count(*) > 1) d))`,
    // Every dish with a recipe in the source has one — and deducts stock — in the copy.
    `'dishes_deducting', json_build_array((select 0), (select count(*) from (select distinct menu_item_id from public.recipe_links where menu_item_id in (${[...new Set((data.rows.recipe_links ?? []).map((x) => `'${String(x.menu_item_id)}'`))].join(',') || 'null'})) l where not exists (select 1 from public.recipe_components rc where rc.menu_item_id = l.menu_item_id)))`,
    `'currency', json_build_array(1, (select case when currency_code = ${data.settings?.currency_code ? `'${String(data.settings.currency_code)}'` : 'currency_code'} then 1 else 0 end from public.business_settings where id))`,
  ];
  const sql = `begin;\n${buildSeedSql(data, { wrap: false })}\nselect json_build_object(${checks.join(', ')}) as result;\nrollback;`;

  const { data: proj } = await supabaseAdmin.from('tenant_projects').select('tenant_id').eq('project_ref', TARGET).maybeSingle();
  if (!proj) throw new Error('unknown target');
  const { data: conn } = await supabaseAdmin.from('supabase_connections').select('tenant_id').eq('tenant_id', proj.tenant_id).maybeSingle();
  // A branch borrows its main restaurant's connection (getFreshConnection resolves it).
  const token = conn || (await hasConnection(proj.tenant_id)) ? (await getFreshConnection(proj.tenant_id)).access_token : env.SUPABASE_ACCESS_TOKEN;
  const res = await fetch(`https://api.supabase.com/v1/projects/${TARGET}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: sql }),
  });
  const text = await res.text();
  if (!res.ok) {
    console.log(`FAIL S0 the copy failed on the target: ${text.slice(0, 600)}`);
    process.exit(1);
  }
  const out = (JSON.parse(text) as { result: Record<string, [number, number]> }[])[0]!.result;
  let fails = 0;
  for (const [k, [want, got]] of Object.entries(out)) {
    const ok = Number(want) === Number(got);
    if (!ok) fails++;
    console.log(`${ok ? 'PASS' : 'FAIL'} ${k}: ${got}/${want}`);
  }
  console.log(`\n${fails} failed (rolled back — nothing changed)`);
  process.exit(fails ? 1 : 0);
}
void main();
