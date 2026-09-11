/* eslint-disable */
// P9 hardening check. Runs SQL assertions against every provisioned tenant via
// the Supabase Management API (same auth path as apply-tenant-migration.cjs).
// Covers the parts that don't need a browser session: catalog + role presets,
// SECURITY DEFINER + EXECUTE grants on the sensitive RPCs, RLS-enabled tables.
// The role-boundary matrix that needs a real login is printed as a checklist.
//
//   node apps/api/scripts/rbac-test.cjs
const { createClient } = require('@supabase/supabase-js');

const ACCESS_TOKEN = process.env.SUPABASE_ACCESS_TOKEN || 'sbp_REPLACE_WITH_YOUR_TOKEN';
const CP = 'https://ckxxpyzxsbhhynlboyid.supabase.co';
const CP_SVC =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNreHhweXp4c2JoaHlubGJveWlkIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc4ODk1NTQzNCwiZXhwIjoyMTA0NTMxNDM0fQ.8Pf3AAJ0MNn9LdcyWxvRARFx6EunjNWEBHj68JBKuP0';

const CHECKS = `
with results as (
  select 'catalog has finance keys' as name,
         (select count(*) >= 12 from public.permission_catalog where key like 'finance.%') as ok
  union all select 'catalog has ai keys',
         (select count(*) = 4 from public.permission_catalog where key like 'ai.%')
  union all select '9 system roles seeded',
         (select count(*) = 9 from public.roles where is_system)
  union all select 'owner preset is {*}',
         (select permissions = array['*'] from public.roles where key = 'owner')
  union all select 'cashier can accept payments',
         (select 'payments.accept' = any(app.compose_permissions('cashier','{}')))
  union all select 'cashier cannot close the day',
         (select not ('finance.close_day' = any(app.compose_permissions('cashier','{}'))))
  union all select 'extra grant composes in',
         (select 'finance.view' = any(app.compose_permissions('waiter', array['finance.view'])))
  union all select 'set_member_access NOT callable by authenticated',
         (select not has_function_privilege('authenticated','public.set_member_access(uuid,text,text[])','execute'))
  union all select 'record_payment NOT callable by anon',
         (select not has_function_privilege('anon','public.record_payment(uuid,integer,text,integer,text)','execute'))
  union all select 'place_order IS callable by anon',
         (select has_function_privilege('anon','public.place_order(text,text,text,integer,jsonb,integer,text,text)','execute'))
  union all select 'refund_payment is SECURITY DEFINER',
         (select prosecdef from pg_proc where proname = 'refund_payment' limit 1)
  union all select 'kitchen_start_order is SECURITY DEFINER',
         (select prosecdef from pg_proc where proname = 'kitchen_start_order' limit 1)
  union all select 'close_business_day is SECURITY DEFINER',
         (select prosecdef from pg_proc where proname = 'close_business_day' limit 1)
  union all select 'RLS on: orders / payments / attendance / deals / daily_closings',
         (select bool_and(relrowsecurity) from pg_class
          where relname in ('orders','payments','attendance','deals','daily_closings') and relnamespace = 'public'::regnamespace)
  union all select 'audit_logs has portal_id',
         (select count(*) = 1 from information_schema.columns
          where table_name = 'audit_logs' and column_name = 'portal_id')
)
select name, ok, case when ok then 'PASS' else 'FAIL' end as verdict from results order by ok, name;
`;

async function runSql(ref, query, token) {
  const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token || ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${ref}: HTTP ${res.status} — ${text}`);
  return JSON.parse(text);
}

(async () => {
  const cp = createClient(CP, CP_SVC, { auth: { persistSession: false } });
  const { data: projects, error } = await cp
    .from('tenant_projects')
    .select('tenant_id, project_ref, schema_version');
  if (error) throw error;
  const { data: conns } = await cp.from('supabase_connections').select('tenant_id, access_token');
  const tokenByTenant = new Map((conns || []).map((c) => [c.tenant_id, c.access_token]));

  let failures = 0;
  for (const p of projects || []) {
    console.log(`\n=== ${p.project_ref} (schema v${p.schema_version}) ===`);
    try {
      const rows = await runSql(p.project_ref, CHECKS, tokenByTenant.get(p.tenant_id));
      for (const r of rows) {
        if (!r.ok) failures++;
        console.log(`  ${r.verdict.padEnd(4)} ${r.name}`);
      }
    } catch (e) {
      failures++;
      console.error('  ERROR', String(e.message || e).slice(0, 400));
    }
  }

  console.log(`
--- Manual role-boundary checklist (needs a real portal / staff login) ---
[ ] Cashier login: can open Checkout, take payment; /finance /staff /portals redirect to dashboard
[ ] Cashier: refund button hidden AND supabase.rpc('refund_payment', …) returns forbidden
[ ] Kitchen portal login: sees only its portal; direct nav to /r/<slug> bounces to its portal
[ ] Kitchen portal: kitchen_start_order works; record_payment / close_business_day return forbidden
[ ] Attendance portal: attendance_check_in works; second check-in same day rejected (already_checked_in)
[ ] Manager (post-0008): can view but not close_day / reopen_day / manage portals / settings.update
[ ] Custom role with only orders.view: every other (portal) page redirects to dashboard
[ ] Two browsers advance the same order — no crash, final state matches the DB
[ ] Force-password-change: fresh portal login lands on /set-portal-password before its portal
`);
  process.exitCode = failures ? 1 : 0;
  console.log(failures ? `\n${failures} automated check(s) FAILED` : '\nAll automated checks passed');
})();
