/* eslint-disable */
// Parent-policy audit: proves no restaurant database lives in an Automation
// Restaurant org. Lists every tenant and which Supabase org holds its project,
// checks the parent account's project list, and flags any violation.
//
//   node apps/api/scripts/audit-db-placement.cjs
const { createClient } = require('@supabase/supabase-js');

const ACCESS_TOKEN = process.env.SUPABASE_ACCESS_TOKEN || 'sbp_REPLACE_WITH_YOUR_TOKEN';
const CP = 'https://ckxxpyzxsbhhynlboyid.supabase.co';
const CP_SVC =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNreHhweXp4c2JoaHlubGJveWlkIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc4ODk1NTQzNCwiZXhwIjoyMTA0NTMxNDM0fQ.8Pf3AAJ0MNn9LdcyWxvRARFx6EunjNWEBHj68JBKuP0';

// Orgs that belong to Automation Restaurant (must match apps/api/.env).
const RESERVED = new Set(
  (process.env.RESERVED_ORGS || 'wbzfvavyrlqruhebxitq,zprxymjzrnnqwsferfov')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
);
const CONTROL_PLANE_REF = 'ckxxpyzxsbhhynlboyid';

(async () => {
  const cp = createClient(CP, CP_SVC, { auth: { persistSession: false } });

  // 1. What's in the parent account?
  const projects = await (
    await fetch('https://api.supabase.com/v1/projects', {
      headers: { Authorization: `Bearer ${ACCESS_TOKEN}` },
    })
  ).json();
  const parentProjects = projects.filter((p) => RESERVED.has(p.organization_id));
  console.log('\n── Projects in Automation Restaurant orgs ──');
  parentProjects.forEach((p) => {
    const tag = p.id === CONTROL_PLANE_REF ? 'control plane (OK)' : '⚠️  TENANT DB IN OUR ACCOUNT';
    console.log(`  ${p.name.padEnd(24)} ${p.id}  [${tag}]`);
  });
  const strayInParent = parentProjects.filter((p) => p.id !== CONTROL_PLANE_REF);

  // 2. Where does each restaurant's DB live?
  const { data: tenants } = await cp
    .from('tenants')
    .select('slug, status, tenant_projects(project_ref, organization_id), supabase_connections(organization_name)')
    .order('created_at', { ascending: true });

  console.log('\n── Restaurant databases ──');
  let violations = strayInParent.length;
  for (const t of tenants || []) {
    const tp = t.tenant_projects;
    if (!tp) {
      console.log(`  ${t.slug.padEnd(24)} (no project — status: ${t.status})`);
      continue;
    }
    const inOurOrg = RESERVED.has(tp.organization_id);
    const orgName = t.supabase_connections?.organization_name || tp.organization_id;
    console.log(
      `  ${t.slug.padEnd(24)} ${tp.project_ref}  in "${orgName}"  ${inOurOrg ? '⚠️  IN OUR ACCOUNT' : 'OK (owner org)'}`,
    );
    if (inOurOrg) violations++;
  }

  console.log(
    '\n' +
      (violations === 0
        ? '✅ PASS — every restaurant DB is in an owner org; parent account holds only the control plane.'
        : `❌ ${violations} violation(s) — a restaurant DB is in an Automation Restaurant org.`),
  );
  process.exit(violations === 0 ? 0 : 1);
})();
