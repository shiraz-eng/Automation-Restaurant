// Give an existing branch the recipe links its one-time copy missed (before 2026-10-20 the
// copy left out recipe_links, so the branch's dishes sold without deducting stock until each
// recipe was re-saved there). Only links and the stock rows built from them change:
//   * a dish in the branch with NO recipe link gets its main restaurant's link — only when
//     that recipe and that dish exist in the branch (same ids since the copy);
//   * every linked recipe's stock rows are rebuilt with app.sync_recipe_components(), which
//     replaces a dish's rows rather than adding beside them (no double deduction).
// Dishes the branch already linked itself are left exactly as they are.
//
//   npx tsx scripts/repair-branch-recipe-links.ts <branch-slug>            rehearsal (rolled back)
//   npx tsx scripts/repair-branch-recipe-links.ts <branch-slug> --apply
import { supabaseAdmin } from '../src/supabase';
import { mgmtClient } from '../src/mgmt';
import { getFreshConnection } from '../src/lib/supabaseOAuth';

const BRANCH = process.argv.slice(2).find((a) => !a.startsWith('--'));
const APPLY = process.argv.includes('--apply');
if (!BRANCH) throw new Error('Usage: repair-branch-recipe-links.ts <branch-slug> [--apply]');

async function sqlFor(slug: string) {
  const { data: t } = await supabaseAdmin.from('tenants').select('id, parent_tenant_id').eq('slug', slug).single();
  if (!t) throw new Error(`unknown restaurant ${slug}`);
  const { data: p } = await supabaseAdmin.from('tenant_projects').select('project_ref').eq('tenant_id', t.id).single();
  const conn = await getFreshConnection(t.id);
  const m = mgmtClient(conn.access_token);
  return { parentId: t.parent_tenant_id as string | null, q: (sql: string) => m.runSql(String(p!.project_ref), sql) as Promise<Record<string, unknown>[]> };
}

const STATE = `select json_build_object(
  'links', (select count(*) from public.recipe_links),
  'dishes_with_recipe_but_no_stock_rows', (select count(*) from (select distinct menu_item_id from public.recipe_links) l
     where not exists (select 1 from public.recipe_components rc where rc.menu_item_id = l.menu_item_id)),
  'double_rows', (select count(*) from (select 1 from public.recipe_components group by menu_item_id, variant_id, inventory_item_id having count(*) > 1) d),
  'per_dish', (select json_agg(x order by x.dish) from (select mi.name as dish,
     (select count(*) from public.recipe_links rl where rl.menu_item_id = mi.id) as linked,
     (select count(*) from public.recipe_components rc where rc.menu_item_id = mi.id) as stock_rows from public.menu_items mi) x)
) as s`;

async function main() {
  const branch = await sqlFor(BRANCH!);
  if (!branch.parentId) throw new Error(`${BRANCH} is not a branch`);
  const { data: parent } = await supabaseAdmin.from('tenants').select('slug').eq('id', branch.parentId).single();
  const main = await sqlFor(String(parent!.slug));
  const links = await main.q(`select recipe_id::text, menu_item_id::text, variant_id::text from public.recipe_links`);
  const json = JSON.stringify(links).replace(/\$/g, '');
  const sql = `begin;
insert into public.recipe_links (recipe_id, menu_item_id, variant_id)
select x.recipe_id, x.menu_item_id, x.variant_id
  from json_to_recordset($l$${json}$l$::json) as x(recipe_id uuid, menu_item_id uuid, variant_id uuid)
 where exists (select 1 from public.recipes r where r.id = x.recipe_id)
   and exists (select 1 from public.menu_items m where m.id = x.menu_item_id)
   and (x.variant_id is null or exists (select 1 from public.menu_variants v where v.id = x.variant_id))
   and not exists (select 1 from public.recipe_links l where l.menu_item_id = x.menu_item_id and l.variant_id is not distinct from x.variant_id)
on conflict do nothing;
select app.sync_recipe_components(r.id) from public.recipes r where exists (select 1 from public.recipe_links l where l.recipe_id = r.id);
${STATE};
${APPLY ? 'commit;' : 'rollback;'}`;
  console.log('before:', JSON.stringify((await branch.q(STATE))[0]!.s));
  const res = await branch.q(sql);
  console.log(APPLY ? 'APPLIED:' : 'REHEARSAL (rolled back):', JSON.stringify((res[res.length - 1] as { s?: unknown })?.s ?? res));
}

main().catch((e) => {
  console.error('FAILED:', String((e as Error).message ?? e).slice(0, 500));
  process.exit(1);
});
