// Finance Phase G tests — food-cost target, food_cost_watch and
// payables_aging (tenant migration 0094). One DO block, rolled back.
//
// Usage (from apps/api):  npx tsx scripts/test-finance-overview.ts [project_ref]
import { supabaseAdmin } from '../src/supabase';
import { getFreshConnection } from '../src/lib/supabaseOAuth';
import { env } from '../src/env';

const REF = process.argv[2] ?? 'uhfwoftjecgjemvwqdbp';

const claims = (sub: string, perms: string[], role = 'staff') =>
  JSON.stringify({ role: 'authenticated', sub, app_metadata: { kind: 'portal', role, permissions: perms } });

const OWNER = claims('00000000-0000-0000-0000-0000000000a1', ['*'], 'owner');
const FINANCE = claims('00000000-0000-0000-0000-0000000000f1', ['finance.view', 'finance.view_cogs']);
const WAITER = claims('00000000-0000-0000-0000-00000000aa17', ['orders.view'], 'waiter');

const SQL = String.raw`
do $$
declare res text := ''; fails int := 0; n int; v int; sup uuid; r record; today date := app.business_day(now());
  mi uuid; mv uuid; rc uuid; rv uuid; item uuid;
begin
  -- ── Payables aging ──
  insert into public.suppliers (name) values ('Aging Supplier — QA') returning id into sup;
  insert into public.supplier_invoices (supplier_id, supplier_invoice_number, invoice_date, due_date, total_cents, status) values
    (sup, 'AG-CUR', today, today + 10, 10000, 'approved'),
    (sup, 'AG-15', today - 40, today - 15, 20000, 'approved'),
    (sup, 'AG-45', today - 70, today - 45, 30000, 'approved'),
    (sup, 'AG-75', today - 100, today - 75, 40000, 'approved'),
    (sup, 'AG-120', today - 150, today - 120, 50000, 'approved'),
    (sup, 'AG-PAIDOFF', today - 20, today - 5, 99999, 'paid');
  perform set_config('request.jwt.claims', '${FINANCE}', true); set local role authenticated;
  select * into r from public.payables_aging() where supplier_id = sup;
  reset role;
  if r.current_cents = 10000 and r.d1_30_cents = 20000 and r.d31_60_cents = 30000 and r.d61_90_cents = 40000
     and r.d90_plus_cents = 50000 and r.total_cents = 150000 and r.invoices = 5 then
    res := res || E'PASS G1 payables aging puts each unpaid invoice in the right overdue bucket (paid ones excluded)\n';
  else fails := fails + 1; res := res || format(E'FAIL G1 %s\n', row_to_json(r)::text); end if;

  -- ── Food cost target ──
  perform set_config('request.jwt.claims', '${OWNER}', true);
  v := public.set_food_cost_target(32.5);
  if v = 3250 and (select food_cost_target_bps from public.business_settings limit 1) = 3250 then
    res := res || E'PASS G2 the food cost target can be set (32.5%)\n';
  else fails := fails + 1; res := res || format(E'FAIL G2 target=%s\n', v); end if;
  begin
    perform public.set_food_cost_target(150);
    fails := fails + 1; res := res || E'FAIL G3 a 150% target was accepted\n';
  exception when check_violation then res := res || E'PASS G3 an impossible target is refused\n'; end;
  perform set_config('request.jwt.claims', '${WAITER}', true); set local role authenticated;
  begin
    perform public.set_food_cost_target(25);
    reset role; fails := fails + 1; res := res || E'FAIL G4 a waiter changed the target\n';
  exception when insufficient_privilege then reset role; res := res || E'PASS G4 a waiter cannot change the target\n'; end;

  -- ── Food cost watch: a dish whose cost rose above target ──
  insert into public.menu_items (name, price_cents) values ('QA Watch Burger', 0) returning id into mi;
  insert into public.menu_variants (menu_item_id, name, price_cents) values (mi, 'Regular', 75000) returning id into mv;
  insert into public.inventory_items (name, unit, cost_cents_per_base_unit) values ('QA Watch Beef', 'g', 200) returning id into item;
  insert into public.recipes (name, recipe_type, menu_item_id, status) values ('QA Watch Burger', 'menu_item', mi, 'active') returning id into rc;
  insert into public.recipe_versions (recipe_id, version, status) values (rc, 1, 'active') returning id into rv;
  update public.recipes set current_version_id = rv where id = rc;
  -- 150 g at Rs 2/g = Rs 300 today; it cost Rs 225 forty days ago (logged below).
  insert into public.recipe_ingredients (recipe_version_id, inventory_item_id, qty_base) values (rv, item, 150);
  insert into public.recipe_cost_log (recipe_version_id, cost_cents, recorded_at) values (rv, 22500, now() - interval '40 days');
  perform set_config('request.jwt.claims', '${FINANCE}', true); set local role authenticated;
  select * into r from public.food_cost_watch(30) where recipe_id = rc;
  reset role;
  if r.price_cents = 75000 and r.cost_cents > r.previous_cost_cents and r.rising and r.over_target = (r.food_cost_pct > 32.5) then
    res := res || format(E'PASS G5 food cost watch: price Rs 750, cost %s → %s, %s%% (target 32.5%%), rising\n',
      r.previous_cost_cents, r.cost_cents, r.food_cost_pct);
  else fails := fails + 1; res := res || format(E'FAIL G5 %s\n', row_to_json(r)::text); end if;

  perform set_config('request.jwt.claims', '${WAITER}', true); set local role authenticated;
  n := 0;
  begin perform * from public.food_cost_watch(30); exception when insufficient_privilege then n := n + 1; end;
  begin perform * from public.payables_aging(); exception when insufficient_privilege then n := n + 1; end;
  reset role;
  if n = 2 then res := res || E'PASS G6 a waiter can see neither food cost nor payables\n';
  else fails := fails + 1; res := res || format(E'FAIL G6 only %s of 2 refused\n', n); end if;

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
