/* eslint-disable */
// Dry-run of the "Connect your Supabase" wiring (Model B) WITHOUT real OAuth
// credentials. Spawns a throwaway API on :4099 with dummy SUPABASE_OAUTH_* set,
// then checks: signup parks at awaiting_connection, /connect/start 302s to the
// Supabase authorize URL with the right params, a CSRF state row is written,
// and status reports the connect_url. Cleans up the test tenant.
const { spawn } = require('node:child_process');
const path = require('node:path');
const { createClient } = require('@supabase/supabase-js');

const CP = 'https://ckxxpyzxsbhhynlboyid.supabase.co';
// Never hard-code this key: it bypasses every RLS policy on the control
// plane. Read from apps/api/.env (not committed) or the environment.
try { process.loadEnvFile(require('node:path').join(__dirname, '..', '.env')); } catch {}
const CP_SVC = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!CP_SVC) throw new Error('Set SUPABASE_SERVICE_ROLE_KEY (apps/api/.env) to run this script.');

const PORT = 4099;
const BASE = `http://localhost:${PORT}`;
let fails = 0;
const check = (name, ok, extra) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`);
  if (!ok) fails++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const server = spawn(
    process.execPath,
    [path.resolve(__dirname, '../dist/server.js')],
    {
      cwd: path.resolve(__dirname, '../../..'),
      env: {
        ...process.env,
        PORT: String(PORT),
        SUPABASE_OAUTH_CLIENT_ID: 'test-client-id',
        SUPABASE_OAUTH_CLIENT_SECRET: 'test-client-secret',
        SUPABASE_OAUTH_REDIRECT_URI: `${BASE}/api/onboarding/connect/callback`,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  server.stdout.on('data', (d) => process.env.VERBOSE && process.stdout.write(`[api] ${d}`));
  server.stderr.on('data', (d) => process.stdout.write(`[api:err] ${d}`));

  const cp = createClient(CP, CP_SVC, { auth: { persistSession: false } });
  let slug, tenantId;
  try {
    // wait for boot
    for (let i = 0; i < 30; i++) {
      try {
        const r = await fetch(`${BASE}/health`);
        if (r.ok) break;
      } catch {}
      await sleep(300);
    }

    const name = 'Connect Test ' + Date.now();
    const signup = await fetch(`${BASE}/api/onboarding/signup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        restaurant_name: name,
        owner_email: `connect+${Date.now()}@example.com`,
        plan: 'growth',
        billing_interval: 'monthly',
      }),
    });
    const sBody = await signup.json();
    slug = sBody.slug;
    check('signup -> 202', signup.status === 202, `got ${signup.status}`);
    check('signup status = awaiting_connection', sBody.status === 'awaiting_connection', sBody.status);
    check('signup returns connect_url', typeof sBody.connect_url === 'string' && sBody.connect_url.includes('/connect/start'));

    const { data: tRow } = await cp
      .from('tenants')
      .select('id, status')
      .eq('slug', slug)
      .single();
    tenantId = tRow.id;
    check('tenant row parked at awaiting_connection', tRow.status === 'awaiting_connection', tRow.status);

    // /connect/start should 302 to Supabase authorize
    const start = await fetch(`${BASE}/api/onboarding/connect/start?slug=${slug}`, {
      redirect: 'manual',
    });
    check('/connect/start -> 302', start.status === 302, `got ${start.status}`);
    const loc = start.headers.get('location') || '';
    const u = (() => { try { return new URL(loc); } catch { return null; } })();
    check('redirects to api.supabase.com/v1/oauth/authorize',
      !!u && u.origin === 'https://api.supabase.com' && u.pathname === '/v1/oauth/authorize', loc.slice(0, 90));
    check('authorize URL has client_id', u && u.searchParams.get('client_id') === 'test-client-id');
    check('authorize URL has response_type=code', u && u.searchParams.get('response_type') === 'code');
    check('authorize URL has redirect_uri', u && u.searchParams.get('redirect_uri') === `${BASE}/api/onboarding/connect/callback`);
    const state = u && u.searchParams.get('state');
    check('authorize URL has a state param', !!state && state.length > 20);

    // a CSRF state row must exist for this tenant
    const { data: states } = await cp
      .from('oauth_states')
      .select('state_hash, consumed_at')
      .eq('tenant_id', tenantId);
    check('oauth_states row written', Array.isArray(states) && states.length >= 1 && !states[0].consumed_at);

    // callback with a bogus/expired state must be rejected
    const badCb = await fetch(`${BASE}/api/onboarding/connect/callback?code=x&state=deadbeef`, {
      redirect: 'manual',
    });
    check('callback rejects unknown state (400)', badCb.status === 400, `got ${badCb.status}`);

    // status endpoint surfaces connect_url while awaiting
    const st = await fetch(`${BASE}/api/onboarding/status/${slug}`).then((r) => r.json());
    check('status endpoint: awaiting_connection + connect_url', st.status === 'awaiting_connection' && !!st.connect_url);
  } finally {
    if (tenantId) await cp.from('tenants').delete().eq('id', tenantId); // cascades states
    server.kill('SIGKILL');
  }

  console.log('\n' + (fails === 0 ? 'ALL CHECKS PASSED' : `${fails} CHECK(S) FAILED`));
  process.exit(fails === 0 ? 0 : 1);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
