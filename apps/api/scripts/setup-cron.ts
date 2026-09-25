// Schedules the API's background jobs (low-stock supplier emails, recipe
// cost tracking, automatic absences) from the CONTROL-PLANE database with
// pg_cron + pg_net, because the API on Vercel has no long-running process
// to run server.ts's setInterval timers.
//
// Each job is an HTTPS call to /api/cron/<job> carrying the token from
// routes/cron.ts (derived from SUPABASE_SERVICE_ROLE_KEY). Re-run this
// after rotating that key or changing the API URL — it replaces the jobs.
//
// Usage (from apps/api):
//   npx tsx scripts/setup-cron.ts [api_base_url]
//   npx tsx scripts/setup-cron.ts --remove
import { env } from '../src/env';
import { derivedCronToken } from '../src/routes/cron';

const arg = process.argv[2];
const API = (arg && !arg.startsWith('--') ? arg : 'https://automation-restaurant-api.vercel.app').replace(/\/$/, '');
const REMOVE = process.argv.includes('--remove');
const CONTROL_PLANE_REF = new URL(env.SUPABASE_URL).hostname.split('.')[0];

const JOBS: { name: string; schedule: string; path: string }[] = [
  { name: 'ar-low-stock', schedule: '*/15 * * * *', path: '/api/cron/low-stock' },
  { name: 'ar-recipe-cost', schedule: '7,22,37,52 * * * *', path: '/api/cron/recipe-cost' },
  { name: 'ar-attendance', schedule: '41 * * * *', path: '/api/cron/attendance' },
  { name: 'ar-provisioning', schedule: '*/2 * * * *', path: '/api/cron/provisioning' },
];

async function sql(query: string) {
  for (let attempt = 1; attempt <= 4; attempt++) {
    const r = await fetch(`https://api.supabase.com/v1/projects/${CONTROL_PLANE_REF}/database/query`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.SUPABASE_ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query }),
    });
    const text = await r.text();
    if (r.ok) return JSON.parse(text || '[]');
    if (r.status < 500 || attempt === 4) throw new Error(`SQL failed (${r.status}): ${text.slice(0, 300)}`);
    await new Promise((res) => setTimeout(res, 5000));
  }
}

const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;

async function main() {
  await sql('create extension if not exists pg_cron; create extension if not exists pg_net;');
  await sql(`select cron.unschedule(jobname) from cron.job where jobname like 'ar-%';`);
  if (REMOVE) {
    console.log('Removed all ar-* jobs.');
    return;
  }
  const token = derivedCronToken();
  for (const j of JOBS) {
    const command =
      `select net.http_post(url := ${lit(API + j.path)}, ` +
      `headers := jsonb_build_object('Authorization', ${lit('Bearer ' + token)}, 'Content-Type', 'application/json'), ` +
      `body := '{}'::jsonb, timeout_milliseconds := 60000);`;
    await sql(`select cron.schedule(${lit(j.name)}, ${lit(j.schedule)}, ${lit(command)});`);
    console.log(`scheduled ${j.name} (${j.schedule}) -> ${API}${j.path}`);
  }
  const rows = await sql(`select jobname, schedule, active from cron.job where jobname like 'ar-%' order by jobname;`);
  console.log(JSON.stringify(rows));
}
main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
