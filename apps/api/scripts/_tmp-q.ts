import { supabaseAdmin } from '../src/supabase';
import { getFreshConnection } from '../src/lib/supabaseOAuth';
const SQL = require('node:fs').readFileSync(process.argv[2], 'utf8');
(async () => {
  const ref = process.argv[3] ?? 'uhfwoftjecgjemvwqdbp';
  const { data: proj } = await supabaseAdmin.from('tenant_projects').select('tenant_id').eq('project_ref', ref).maybeSingle();
  const token = (await getFreshConnection(proj!.tenant_id)).access_token;
  const r = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ query: SQL }) });
  console.log(await r.text());
})();
