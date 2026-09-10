/* eslint-disable */
// Apply a tenant delta migration to every provisioned tenant project via the
// Supabase Management API.  Usage:
//   node apps/api/scripts/apply-tenant-migration.cjs supabase/tenant-migrations/0002_...sql
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const ACCESS_TOKEN = process.env.SUPABASE_ACCESS_TOKEN || 'sbp_REPLACE_WITH_YOUR_TOKEN';
const CP = 'https://ckxxpyzxsbhhynlboyid.supabase.co';
const CP_SVC =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNreHhweXp4c2JoaHlubGJveWlkIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc4ODk1NTQzNCwiZXhwIjoyMTA0NTMxNDM0fQ.8Pf3AAJ0MNn9LdcyWxvRARFx6EunjNWEBHj68JBKuP0';

async function runSql(ref, query, token) {
  const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token || ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${ref}: HTTP ${res.status} — ${text}`);
  return text;
}

(async () => {
  const file = process.argv[2];
  if (!file) throw new Error('pass the migration .sql path');
  const sql = fs.readFileSync(path.resolve(file), 'utf8');
  // tenant_projects.schema_version is an integer; migrations are 0001, 0002, ...
  const version = Number.parseInt(path.basename(file).slice(0, 4), 10);
  if (!Number.isFinite(version)) throw new Error('migration file must start with NNNN');

  const cp = createClient(CP, CP_SVC, { auth: { persistSession: false } });
  const { data: projects, error } = await cp
    .from('tenant_projects')
    .select('tenant_id, project_ref, schema_version');
  if (error) throw error;
  if (!projects || projects.length === 0) {
    console.log('no tenant projects to migrate');
    return;
  }
  const { data: conns } = await cp
    .from('supabase_connections')
    .select('tenant_id, access_token');
  const tokenByTenant = new Map((conns || []).map((c) => [c.tenant_id, c.access_token]));

  for (const p of projects) {
    // Owner-org tenants (Model B) aren't reachable with the platform token —
    // use their OAuth access token (Database:Write scope covers /database/query).
    const token = tokenByTenant.get(p.tenant_id) || null;
    process.stdout.write(
      `→ ${p.project_ref} (v${p.schema_version} → v${version})${token ? ' [oauth]' : ''} ... `,
    );
    try {
      await runSql(p.project_ref, sql, token);
      const { error: upErr } = await cp
        .from('tenant_projects')
        .update({ schema_version: version })
        .eq('tenant_id', p.tenant_id);
      if (upErr) throw upErr;
      console.log('ok');
    } catch (e) {
      console.log('FAILED');
      console.error(String(e.message || e).slice(0, 2000));
      process.exitCode = 1;
    }
  }
})();
