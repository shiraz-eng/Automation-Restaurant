// Tenant migration 0112 (RLS on invoice_counter) for BBQ Tonight and its branches.
// Usage (from apps/api):
//   npx tsx scripts/check-invoice-counter-rls.ts [parent_slug]             read-only state
//   npx tsx scripts/check-invoice-counter-rls.ts [parent_slug] --rehearse  apply + test, then roll back
// The rehearsal runs in one DO block that ends with RAISE EXCEPTION, so nothing it does is kept
// (including the two next_invoice_ref() calls); the exception message carries the results.
import { supabaseAdmin } from '../src/supabase';
import { getFreshConnection, hasConnection } from '../src/lib/supabaseOAuth';
import { env } from '../src/env';

const PARENT = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : 'bbq-tonight';
const REHEARSE = process.argv.includes('--rehearse');

const STATE = `select c.relrowsecurity as rls,
  (select count(*) from pg_policies where schemaname = 'public' and tablename = 'invoice_counter') as policies,
  has_table_privilege('anon', 'public.invoice_counter', 'select') as anon_select_grant,
  (select next_number from public.invoice_counter) as next_number
  from pg_class c where c.oid = 'public.invoice_counter'::regclass`;

const REHEARSAL = `do $$
declare pre_anon text; post_anon text; post_auth text; upd text := '-'; r1 bigint; r2 bigint;
begin
  begin execute 'set local role anon'; select count(*)::text into pre_anon from public.invoice_counter;
  exception when others then pre_anon := 'error: ' || sqlerrm; end;
  execute 'reset role';
  execute 'alter table public.invoice_counter enable row level security';
  begin execute 'set local role anon'; select count(*)::text into post_anon from public.invoice_counter;
  exception when others then post_anon := 'error: ' || sqlerrm; end;
  execute 'reset role';
  begin
    execute 'set local role authenticated';
    select count(*)::text into post_auth from public.invoice_counter;
    update public.invoice_counter set next_number = next_number + 1000;
    get diagnostics upd = row_count;
    r1 := public.next_invoice_ref();
    r2 := public.next_invoice_ref();
  exception when others then post_auth := 'error: ' || sqlerrm; end;
  execute 'reset role';
  raise exception 'REHEARSAL anon rows before=% after=% | authenticated rows=% direct update rows=% | next_invoice_ref()=%,%',
    pre_anon, post_anon, post_auth, upd, r1, r2;
end $$`;

async function main() {
  const { data: parent } = await supabaseAdmin.from('tenants').select('id, slug').eq('slug', PARENT).single();
  const { data: kids } = await supabaseAdmin.from('tenants').select('id, slug').eq('parent_tenant_id', parent!.id);
  for (const t of [parent!, ...(kids ?? [])]) {
    const { data: proj } = await supabaseAdmin.from('tenant_projects').select('project_ref, schema_version').eq('tenant_id', t.id).maybeSingle();
    if (!proj?.project_ref) { console.log(`${t.slug}: no project`); continue; }
    const token = (await hasConnection(t.id)) ? (await getFreshConnection(t.id)).access_token : env.SUPABASE_ACCESS_TOKEN;
    const r = await fetch(`https://api.supabase.com/v1/projects/${proj.project_ref}/database/query`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: REHEARSE ? REHEARSAL : STATE }),
    });
    const body = await r.text();
    const msg = REHEARSE ? (body.match(/REHEARSAL[^"\\]*/)?.[0] ?? body.slice(0, 400)) : body;
    console.log(`${t.slug} (${proj.project_ref}, recorded v${proj.schema_version}): ${msg}`);
  }
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
