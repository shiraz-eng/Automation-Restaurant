// Demo branches for one restaurant (multi-branch, tenant-migrations 0098+). COMMITS — this is
// demo data, not a test. Safe to re-run: existing demo branches and demo orders are kept.
//
//   DHA  "DHA Phase 6"  and  CLF  "Clifton" (Karachi, PKR)
//   - DHA charges its own price for one dish (branch menu price)
//   - a small stock transfer MAIN → DHA
//   - paid demo orders (customer "Demo guest") at DHA and CLF, from real menu dishes
//
// Everything runs as the restaurant's owner account, so the audit log records who did it.
// Undo: void the "Demo guest" orders and archive the two branches on the Branches page.
//
// Usage (from apps/api):  npx tsx scripts/seed-demo-branches.ts <project_ref>
import { supabaseAdmin } from '../src/supabase';
import { getFreshConnection } from '../src/lib/supabaseOAuth';
import { env } from '../src/env';

const REF = process.argv[2];
if (!REF) throw new Error('pass the project ref');

const SQL = String.raw`
do $$
declare
  v_owner uuid; claims text; b_main uuid; b_dha uuid; b_clf uuid; br uuid;
  v_mi uuid; v_mv uuid; v_price int; v_item uuid; v_qty numeric; o uuid; n int := 0; d record; res text := '';
begin
  select user_id into v_owner from public.memberships where role = 'owner' and user_id is not null order by created_at limit 1;
  if v_owner is null then raise exception 'no owner account'; end if;
  claims := json_build_object('role', 'authenticated', 'sub', v_owner,
    'app_metadata', json_build_object('role', 'owner', 'permissions', json_build_array('*')))::text;
  perform set_config('request.jwt.claims', claims, true);
  b_main := app.default_branch_id();

  -- Branches
  select id into b_dha from public.branches where code = 'DHA';
  if b_dha is null then
    b_dha := (public.create_branch('DHA', 'DHA Phase 6', 'Khayaban-e-Ittehad, Phase 6', 'Karachi', 'Pakistan', 'Asia/Karachi', 'PKR')).id;
    res := res || 'created DHA; ';
  end if;
  select id into b_clf from public.branches where code = 'CLF';
  if b_clf is null then
    b_clf := (public.create_branch('CLF', 'Clifton', 'Block 5, Clifton', 'Karachi', 'Pakistan', 'Asia/Karachi', 'PKR')).id;
    res := res || 'created CLF; ';
  end if;

  -- DHA's own price for the first dish on the menu (+10%)
  select mi.id, mv.id, mv.price_cents into v_mi, v_mv, v_price
    from public.menu_items mi join public.menu_variants mv on mv.menu_item_id = mi.id
   where mi.is_available and mv.is_available order by mi.name, mv.sort_order limit 1;
  if v_mi is not null and not exists (select 1 from public.branch_menu_overrides where branch_id = b_dha) then
    perform public.set_branch_menu_override(b_dha, v_mi, v_mv, (round(v_price * 1.1 / 100.0) * 100)::int, null);
    res := res || 'DHA price set; ';
  end if;

  -- A small stock transfer MAIN → DHA (a tenth of the best-stocked ingredient)
  if not exists (select 1 from public.stock_ledger where branch_id = b_dha and note like '%Demo%') then
    select bs.inventory_item_id, bs.stock_qty into v_item, v_qty from public.branch_stock bs
     where bs.branch_id = b_main and bs.stock_qty > 0 order by bs.stock_qty desc limit 1;
    if v_item is not null then
      perform public.transfer_stock(v_item, b_main, b_dha, round(v_qty / 10, 2), 'Demo — opening stock for DHA');
      res := res || 'stock transferred; ';
    end if;
  end if;

  -- Paid demo orders: real dishes and prices, recipe cost at 35% (a typical food cost)
  if not exists (select 1 from public.orders where customer_name = 'Demo guest' and branch_id in (b_dha, b_clf)) then
    for d in
      select mi.name, mv.name as vname, mv.price_cents as price, row_number() over (order by mi.name, mv.sort_order) as k
        from public.menu_items mi join public.menu_variants mv on mv.menu_item_id = mi.id
       where mi.is_available and mv.is_available and mv.price_cents > 0
       order by mi.name, mv.sort_order limit 6
    loop
      br := case when d.k % 3 = 0 then b_clf else b_dha end;
      insert into public.orders (order_number, status, subtotal_cents, total_cents, channel, customer_name, branch_id)
        values ((select coalesce(max(order_number), 0) + 1 from public.orders), 'served', d.price * 2, d.price * 2,
                (case when d.k % 2 = 0 then 'takeaway' else 'dine_in' end)::app.order_channel, 'Demo guest', br)
        returning id into o;
      insert into public.order_lines (order_id, name_snapshot, variant_name_snapshot, unit_price_cents, qty, line_total_cents, recipe_cost_cents)
        values (o, d.name, d.vname, d.price, 2, d.price * 2, round(d.price * 2 * 0.35));
      perform set_config('request.headers', json_build_object('x-branch-ids', br)::text, true);
      set local role authenticated;
      perform public.record_payment(o, d.price * 2, case when d.k % 2 = 0 then 'card' else 'cash' end, null, null);
      reset role;
      n := n + 1;
    end loop;
    perform set_config('request.headers', '{}', true);
    res := res || n || ' demo orders paid; ';
  end if;

  raise notice 'DEMO %', coalesce(nullif(res, ''), 'already there, nothing to do');
end $$;
select b.code, b.name, s.orders_count, s.net_sales_cents
  from public.branches b left join lateral (select * from public.branch_summary(current_date - 30, current_date + 1) x where x.branch_id = b.id) s on true
 order by b.is_default desc, b.code;
`;

async function main() {
  const { data: proj } = await supabaseAdmin.from('tenant_projects').select('tenant_id').eq('project_ref', REF).maybeSingle();
  if (!proj) throw new Error('unknown project');
  const { data: conn } = await supabaseAdmin.from('supabase_connections').select('tenant_id').eq('tenant_id', proj.tenant_id).maybeSingle();
  const token = conn ? (await getFreshConnection(proj.tenant_id)).access_token : env.SUPABASE_ACCESS_TOKEN;
  const res = await fetch(`https://api.supabase.com/v1/projects/${REF}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    // --dry: run everything, then roll it back (the result is reported in the error).
    body: JSON.stringify({
      query: process.argv.includes('--dry') ? SQL.replace("raise notice 'DEMO %'", "raise exception 'DRY RUN (rolled back): %'") : SQL,
    }),
  });
  console.log(res.status, await res.text());
}
void main();
