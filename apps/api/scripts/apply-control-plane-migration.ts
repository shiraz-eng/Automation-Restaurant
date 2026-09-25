// Applies one supabase/control-plane/*.sql file to the control-plane project
// through the Management API (retrying the intermittent 5xx/522s).
//
// Usage (from apps/api):  npx tsx scripts/apply-control-plane-migration.ts ../../supabase/control-plane/<file>.sql
import { readFileSync } from 'node:fs';
import { env } from '../src/env';

const file = process.argv[2];
if (!file) throw new Error('Pass the migration file path.');
const ref = new URL(env.SUPABASE_URL).hostname.split('.')[0];

async function main() {
  const query = readFileSync(file, 'utf8');
  for (let attempt = 1; attempt <= 5; attempt++) {
    const r = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.SUPABASE_ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query }),
    });
    const text = await r.text();
    if (r.ok) return console.log(`applied ${file} to ${ref}`);
    if (r.status < 500 || attempt === 5) throw new Error(`failed (${r.status}): ${text.slice(0, 400)}`);
    await new Promise((res) => setTimeout(res, 5000));
  }
}
main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
