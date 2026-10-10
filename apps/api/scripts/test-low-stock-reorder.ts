// Low-stock reorder email — the SQL side the cron sweep depends on.
// pending_low_stock_reorders() must run for the service role (the cron job's
// key) and pick the right item and supplier; 0082 broke it with a column
// that doesn't exist and no email was sent for ~10 days. One DO block,
// rolled back — no email is sent.
//
// Usage (from apps/api):  npx tsx scripts/test-low-stock-reorder.ts [project_ref]
import { supabaseAdmin } from '../src/supabase';
import { getFreshConnection } from '../src/lib/supabaseOAuth';
import { env } from '../src/env';

const REF = process.argv[2] ?? 'uhfwoftjecgjemvwqdbp';
// PRE_SQL=<file>: run a migration first inside the same rolled-back transaction (rehearsal).
const PRE = process.env.PRE_SQL ? require('node:fs').readFileSync(process.env.PRE_SQL, 'utf8') + String.fromCharCode(10) : '';

const SQL = String.raw`
do $$
declare res text := ''; fails int := 0; n int; r record; item uuid; s1 uuid; s2 uuid; err text;
begin
  update public.purchasing_settings set low_stock_email_enabled = true;
  insert into public.inventory_items (name, unit, stock_qty, min_threshold, target_stock_qty)
    values ('QA Reorder Flour', 'g', 50000, 10000, 40000) returning id into item;
  insert into public.suppliers (name, email) values ('QA Backup Mill', 'backup-mill@example.test') returning id into s1;
  insert into public.suppliers (name, email) values ('QA Preferred Mill', 'preferred-mill@example.test') returning id into s2;
  insert into public.supplier_items (supplier_id, inventory_item_id, is_preferred) values (s1, item, false), (s2, item, true);

  -- Stock falls to the reorder level → an open low-stock event
  update public.inventory_items set stock_qty = 8000 where id = item;
  select count(*) into n from public.low_stock_events where inventory_item_id = item and status = 'open';
  if n = 1 then res := res || E'PASS R1 stock at or below the reorder level opens a low-stock event\n';
  else fails := fails + 1; res := res || format(E'FAIL R1 open events=%s\n', n); end if;

  -- What the cron job sees (service-role key)
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  set local role service_role;
  begin
    select * into r from public.pending_low_stock_reorders() where inventory_item_id = item;
  exception when others then err := sqlerrm; end;
  reset role;
  if err is null and r.supplier_id = s2 and r.supplier_email = 'preferred-mill@example.test' and r.suggested_qty = 32000 then
    res := res || E'PASS R2 the cron job gets the reorder: preferred supplier, suggested 32,000 g (target 40,000 − 8,000)\n';
  else fails := fails + 1; res := res || format(E'FAIL R2 err=%s row=%s\n', err, row_to_json(r)::text); end if;

  -- Once sent, it is not sent again
  insert into public.supplier_communications (supplier_id, inventory_item_id, low_stock_event_id, kind, subject, body, recipient_email, status)
    select s2, item, id, 'low_stock_reorder', 'QA', 'QA', 'preferred-mill@example.test', 'sent'
      from public.low_stock_events where inventory_item_id = item and status = 'open';
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  set local role service_role;
  select count(*) into n from public.pending_low_stock_reorders() where inventory_item_id = item;
  reset role;
  if n = 0 then res := res || E'PASS R3 a reorder already emailed is not emailed again\n';
  else fails := fails + 1; res := res || format(E'FAIL R3 still pending=%s\n', n); end if;

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
    body: JSON.stringify({ query: PRE + SQL }),
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
