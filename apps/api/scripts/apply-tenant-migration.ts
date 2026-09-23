// Apply a tenant delta migration to every provisioned tenant project via the
// Supabase Management API. Reuses the real getFreshConnection() so Model B
// (owner-org, OAuth-connected) tenants get a refreshed access token instead
// of failing with 401 on an expired stored one. Usage:
//   npx tsx apps/api/scripts/apply-tenant-migration.ts supabase/tenant-migrations/0056_....sql
import { readFileSync } from 'node:fs';
import { resolve, basename } from 'node:path';
import { env } from '../src/env';
import { supabaseAdmin } from '../src/supabase';
import { getFreshConnection } from '../src/lib/supabaseOAuth';

async function runSql(ref: string, query: string, token: string): Promise<void> {
  const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${ref}: HTTP ${res.status} — ${text}`);
}

async function main() {
  const file = process.argv[2];
  if (!file) throw new Error('pass the migration .sql path');
  const sql = readFileSync(resolve(file), 'utf8');
  const version = Number.parseInt(basename(file).slice(0, 4), 10);
  if (!Number.isFinite(version)) throw new Error('migration file must start with NNNN');

  const { data: projects, error } = await supabaseAdmin
    .from('tenant_projects')
    .select('tenant_id, project_ref, schema_version');
  if (error) throw error;
  if (!projects || projects.length === 0) {
    console.log('no tenant projects to migrate');
    return;
  }

  const { data: conns } = await supabaseAdmin.from('supabase_connections').select('tenant_id');
  const oauthTenantIds = new Set((conns ?? []).map((c: { tenant_id: string }) => c.tenant_id));

  let failed = 0;
  for (const p of projects as { tenant_id: string; project_ref: string; schema_version: number }[]) {
    const isOauth = oauthTenantIds.has(p.tenant_id);
    process.stdout.write(`→ ${p.project_ref} (v${p.schema_version} → v${version})${isOauth ? ' [oauth]' : ''} ... `);
    try {
      const token = isOauth ? (await getFreshConnection(p.tenant_id)).access_token : env.SUPABASE_ACCESS_TOKEN;
      await runSql(p.project_ref, sql, token);
      const { error: upErr } = await supabaseAdmin
        .from('tenant_projects')
        .update({ schema_version: version })
        .eq('tenant_id', p.tenant_id);
      if (upErr) throw upErr;
      console.log('ok');
    } catch (e) {
      failed++;
      console.log('FAILED');
      console.error(String((e as Error).message || e).slice(0, 2000));
    }
  }
  if (failed > 0) process.exitCode = 1;
}

main();
