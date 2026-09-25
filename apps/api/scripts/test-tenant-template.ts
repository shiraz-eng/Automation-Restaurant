// Dry-runs supabase/tenant-template/schema.sql (what provisioning applies to
// a brand-new restaurant) against a real, EMPTY tenant project inside a
// transaction that always rolls back — so the project is left untouched.
// Reports the first failing statement, if any.
//
// Usage (from apps/api):  npx tsx scripts/test-tenant-template.ts <project_ref>
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { supabaseAdmin } from '../src/supabase';
import { getFreshConnection } from '../src/lib/supabaseOAuth';
import { env } from '../src/env';

const REF = process.argv[2];
if (!REF) throw new Error('Pass the project ref of an empty tenant project.');

async function token(): Promise<string> {
  const { data: proj } = await supabaseAdmin.from('tenant_projects').select('tenant_id').eq('project_ref', REF).maybeSingle();
  if (proj) {
    const { data: conns } = await supabaseAdmin.from('supabase_connections').select('tenant_id').eq('tenant_id', proj.tenant_id);
    if (conns && conns.length) return (await getFreshConnection(proj.tenant_id)).access_token;
  }
  return env.SUPABASE_ACCESS_TOKEN as string;
}

async function query(t: string, sql: string) {
  const r = await fetch(`https://api.supabase.com/v1/projects/${REF}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: sql }),
  });
  return { status: r.status, text: await r.text() };
}

async function main() {
  const t = await token();
  const count = await query(t, "select count(*) as tables from information_schema.tables where table_schema = 'public'");
  console.log('public tables before:', count.text);
  const schema = readFileSync(resolve(__dirname, '../../../supabase/tenant-template/schema.sql'), 'utf8');
  // After the whole template is in place, re-create every SQL-language
  // function WITH body checking on — the template builds them with it off
  // (forward references), so this is what catches a genuinely broken body.
  const recheck = `
set check_function_bodies = on;
do $chk$
declare r record;
begin
  for r in
    select p.oid, n.nspname, p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname in ('public', 'app') and p.prolang = (select oid from pg_language where lanname = 'sql')
  loop
    begin
      execute pg_get_functiondef(r.oid);
    exception when others then
      raise exception 'function %.% is broken: %', r.nspname, r.proname, sqlerrm;
    end;
  end loop;
end $chk$;
select app.membership_effective_permissions('owner', '{}', gen_random_uuid());`;
  const res = await query(t, `begin;\n${schema}\n;${recheck}\nrollback;`);
  if (res.status >= 400) {
    let msg = res.text;
    try {
      msg = (JSON.parse(res.text) as { message?: string }).message ?? res.text;
    } catch {
      /* not JSON */
    }
    const lm = /LINE (\d+):/.exec(msg);
    const line = lm ? Number(lm[1]) - 1 : null; // the prepended "begin;" shifts lines by one
    console.log('FAILED:', msg.slice(0, 600));
    if (line) {
      const lines = schema.split(/\r?\n/);
      console.log(`schema.sql line ${line}:`, lines[line - 1]?.trim());
    }
    process.exitCode = 1;
  } else {
    console.log('OK — the whole template applied cleanly (rolled back).');
  }
  const after = await query(t, "select count(*) as tables from information_schema.tables where table_schema = 'public'");
  console.log('public tables after:', after.text);
}
main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
