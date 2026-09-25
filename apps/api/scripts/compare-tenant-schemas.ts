// Compares two tenant databases object by object — tables/columns,
// functions (with argument types), RLS policies, triggers, indexes, views,
// storage buckets, realtime tables, the permission catalog and roles — and
// prints what exists in one but not the other. Used to check that a newly
// provisioned restaurant (built from tenant-template/schema.sql in one go)
// matches one that received every migration over time.
//
// Usage (from apps/api):  npx tsx scripts/compare-tenant-schemas.ts <refA> <refB>
import { supabaseAdmin } from '../src/supabase';
import { getFreshConnection } from '../src/lib/supabaseOAuth';
import { env } from '../src/env';

const [A, B] = process.argv.slice(2);
if (!A || !B) throw new Error('Pass two project refs.');

async function tokenFor(ref: string): Promise<string> {
  const { data: proj } = await supabaseAdmin.from('tenant_projects').select('tenant_id').eq('project_ref', ref).maybeSingle();
  if (proj) {
    const { data: conns } = await supabaseAdmin.from('supabase_connections').select('tenant_id').eq('tenant_id', proj.tenant_id);
    if (conns && conns.length) return (await getFreshConnection(proj.tenant_id)).access_token;
  }
  return env.SUPABASE_ACCESS_TOKEN as string;
}

async function q(ref: string, token: string, sql: string): Promise<Record<string, unknown>[]> {
  for (let attempt = 1; attempt <= 4; attempt++) {
    const r = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: sql }),
    });
    const text = await r.text();
    if (r.ok) return JSON.parse(text || '[]');
    if (r.status < 500 || attempt === 4) throw new Error(`${ref}: ${r.status} ${text.slice(0, 200)}`);
    await new Promise((res) => setTimeout(res, 4000));
  }
  return [];
}

const CHECKS: Record<string, string> = {
  columns: `select table_schema||'.'||table_name||'.'||column_name||' '||data_type as k
              from information_schema.columns where table_schema in ('public','app')`,
  functions: `select n.nspname||'.'||p.proname||'('||pg_get_function_identity_arguments(p.oid)||')' as k
                from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('public','app')`,
  policies: `select schemaname||'.'||tablename||' '||policyname||' '||cmd as k from pg_policies where schemaname in ('public','storage')`,
  rls_enabled: `select n.nspname||'.'||c.relname as k from pg_class c join pg_namespace n on n.oid=c.relnamespace
                  where n.nspname='public' and c.relkind='r' and c.relrowsecurity`,
  triggers: `select event_object_schema||'.'||event_object_table||' '||trigger_name||' '||event_manipulation as k
               from information_schema.triggers where event_object_schema in ('public','app','auth')`,
  indexes: `select schemaname||'.'||indexname as k from pg_indexes where schemaname in ('public','app')`,
  views: `select table_schema||'.'||table_name as k from information_schema.views where table_schema in ('public','app')`,
  enum_values: `select n.nspname||'.'||t.typname||'='||e.enumlabel as k from pg_enum e join pg_type t on t.oid=e.enumtypid
                  join pg_namespace n on n.oid=t.typnamespace`,
  storage_buckets: `select id||' public='||public as k from storage.buckets`,
  realtime_tables: `select schemaname||'.'||tablename as k from pg_publication_tables where pubname='supabase_realtime'`,
  permission_catalog: `select key as k from public.permission_catalog`,
  roles: `select key||' ['||array_to_string(array(select unnest(permissions) order by 1), ',')||']' as k from public.roles`,
  function_grants: `select routine_schema||'.'||routine_name||' '||grantee as k from information_schema.routine_privileges
                      where routine_schema='public' and grantee in ('anon','authenticated')`,
};

async function main() {
  const [ta, tb] = await Promise.all([tokenFor(A), tokenFor(B)]);
  let totalDiffs = 0;
  for (const [name, sql] of Object.entries(CHECKS)) {
    let ra: string[];
    let rb: string[];
    try {
      [ra, rb] = await Promise.all([q(A, ta, sql), q(B, tb, sql)]).then((rs) => rs.map((r) => r.map((x) => String(x.k))));
    } catch (e) {
      console.log(`${name}: could not compare — ${(e as Error).message}`);
      continue;
    }
    const sa = new Set(ra);
    const sb = new Set(rb);
    const onlyA = [...sa].filter((x) => !sb.has(x)).sort();
    const onlyB = [...sb].filter((x) => !sa.has(x)).sort();
    totalDiffs += onlyA.length + onlyB.length;
    console.log(`${name}: ${sa.size} vs ${sb.size}${onlyA.length || onlyB.length ? '' : ' — identical'}`);
    for (const x of onlyA.slice(0, 40)) console.log(`   only in ${A}: ${x}`);
    if (onlyA.length > 40) console.log(`   … ${onlyA.length - 40} more only in ${A}`);
    for (const x of onlyB.slice(0, 40)) console.log(`   only in ${B}: ${x}`);
    if (onlyB.length > 40) console.log(`   … ${onlyB.length - 40} more only in ${B}`);
  }
  console.log(`\nTOTAL differences: ${totalDiffs}`);
}
main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
