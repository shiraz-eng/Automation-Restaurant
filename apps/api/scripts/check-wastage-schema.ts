// Read-only: which BBQ Tonight restaurants (main + branches) have tenant migrations 0108 / 0109.
// Usage (from apps/api):  npx tsx scripts/check-wastage-schema.ts [parent_slug]
import { supabaseAdmin } from '../src/supabase';
import { getFreshConnection, hasConnection } from '../src/lib/supabaseOAuth';
import { env } from '../src/env';

const PARENT = process.argv[2] ?? 'bbq-tonight';

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
      body: JSON.stringify({ query: "select to_regclass('public.ai_module_settings') is not null as has_0108, to_regclass('public.waste_entries') is not null as has_0109" }),
    });
    console.log(`${t.slug} (${proj.project_ref}, recorded v${proj.schema_version}): ${await r.text()}`);
  }
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
