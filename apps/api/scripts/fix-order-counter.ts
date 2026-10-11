// Repair: move order_counter past the highest order number in use. Needed after rows were
// inserted into orders with their own order_number (e.g. seed-demo-branches.ts before its fix),
// which left place_order() handing out numbers that already exist.
//   npx tsx scripts/fix-order-counter.ts <project_ref>
import { supabaseAdmin } from '../src/supabase';
import { getFreshConnection } from '../src/lib/supabaseOAuth';
import { env } from '../src/env';

const REF = process.argv[2];
if (!REF) throw new Error('pass the project ref');

const SQL = `
update public.order_counter
   set next_number = greatest(next_number, (select coalesce(max(order_number), 0) + 1 from public.orders))
 where id
returning next_number;
`;

async function main() {
  const { data: proj } = await supabaseAdmin.from('tenant_projects').select('tenant_id').eq('project_ref', REF).maybeSingle();
  if (!proj) throw new Error('unknown project');
  const { data: conn } = await supabaseAdmin.from('supabase_connections').select('tenant_id').eq('tenant_id', proj.tenant_id).maybeSingle();
  const token = conn ? (await getFreshConnection(proj.tenant_id)).access_token : env.SUPABASE_ACCESS_TOKEN;
  const res = await fetch(`https://api.supabase.com/v1/projects/${REF}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: SQL }),
  });
  console.log(res.status, await res.text());
}
void main();
