// Finance Phase H — cross-restaurant and anonymous access tests, run against
// the LIVE API and each restaurant's own database. Read-only: no accounts
// are created and every request is expected to be refused. Keys are held in
// memory only and never printed.
//
//   I1  every slug resolves to its own database (no two restaurants share one)
//   I2  restaurant A's key is rejected by restaurant B's database
//   I3  anonymous visitors read no finance rows (tables, RPCs, file buckets)
//   I4  the API refuses finance/report/AI routes with no token, a garbage
//       token, a forged "owner" token, or another restaurant's key
//   I5  an unknown restaurant gets a plain 404, nothing else
//
// Usage (from apps/api):  npx tsx scripts/test-tenant-isolation.ts [api_base]
import { createHmac, randomBytes } from 'node:crypto';
import { supabaseAdmin } from '../src/supabase';

const API = (process.argv[2] ?? 'https://automation-restaurant-api.vercel.app').replace(/\/$/, '');
const REFS = ['iwccsyjuplkwaxswpgyw', 'uhfwoftjecgjemvwqdbp', 'yloyvprgdkthzfcfbhrm', 'qmeorneaiodipuhcyqhm', 'ornkhhbehjigerfvmzlp'];

const FINANCE_TABLES = [
  'financial_events', 'expenses', 'payments', 'supplier_invoices', 'supplier_invoice_lines', 'supplier_payments',
  'supplier_payment_allocations', 'supplier_payment_holds', 'supplier_credit_notes', 'cash_movements', 'cash_counts',
  'daily_closings', 'supplier_invoice_import_drafts', 'purchase_orders',
];
const today = new Date().toISOString().slice(0, 10);
const FINANCE_RPCS: [string, Record<string, unknown>][] = [
  ['ledger_summary', { p_from: '2000-01-01', p_to: today }],
  ['ledger_events', { p_from: '2000-01-01', p_to: today }],
  ['payables_aging', {}],
  ['food_cost_watch', { p_days: 30 }],
  ['supplier_payable', {}],
  ['day_close_preview', { p_business_date: today, p_opening_cash: 0 }],
  ['period_profitability', { p_from: '2000-01-01T00:00:00Z', p_to: `${today}T23:59:59Z` }],
  ['post_ledger_adjustment', { p_category: 'cash', p_amount_cents: 1, p_reason: 'isolation test' }],
  ['set_food_cost_target', { p_pct: 30 }],
];
const BUCKETS = ['supplier-invoices', 'expense-receipts'];
const API_ROUTES: [string, string][] = [
  ['GET', '/api/ai/export/excel?domain=finance'],
  ['GET', '/api/ai/export-history'],
  ['GET', '/api/ai/intelligence'],
  ['GET', '/api/ai/pending'],
  ['POST', '/api/ai/supplier-invoice-import'],
  ['POST', '/api/ai/supplier-invoice-import/apply'],
  ['POST', '/api/ai/supplier-invoice-import/reject'],
  ['GET', '/api/billing/invoices'],
];

let fails = 0;
const check = (name: string, ok: boolean, detail = '') => {
  if (!ok) fails += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${!ok && detail ? ` — ${detail}` : ''}`);
};

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
function forgedOwnerToken(ref: string) {
  const head = b64({ alg: 'HS256', typ: 'JWT' });
  const body = b64({
    iss: `https://${ref}.supabase.co/auth/v1`, sub: '00000000-0000-0000-0000-0000000000a1', aud: 'authenticated',
    role: 'authenticated', exp: Math.floor(Date.now() / 1000) + 3600,
    app_metadata: { role: 'owner', permissions: ['*'] },
  });
  const sig = createHmac('sha256', randomBytes(32)).update(`${head}.${body}`).digest('base64url');
  return `${head}.${body}.${sig}`;
}

/** Rows a response leaked: >0 only for a 2xx with a non-empty result. */
async function leaked(r: Response): Promise<number> {
  if (!r.ok) return 0;
  const j = (await r.json().catch(() => null)) as unknown;
  if (Array.isArray(j)) return j.length;
  if (j && typeof j === 'object') return Object.keys(j as object).length ? 1 : 0;
  return j == null ? 0 : 1;
}

async function main() {
  const { data: projects, error } = await supabaseAdmin
    .from('tenant_projects')
    .select('project_ref, project_url, anon_key, tenants(slug)')
    .in('project_ref', REFS);
  if (error) throw error;
  const rows = ((projects ?? []) as unknown as { project_ref: string; project_url: string; anon_key: string; tenants: { slug: string } | null }[])
    .map((p) => ({ ref: p.project_ref, project_url: p.project_url, anon_key: p.anon_key, slug: p.tenants?.slug ?? p.project_ref }))
    .filter((t) => t.anon_key);
  console.log(`Restaurants under test: ${rows.map((t) => t.slug).join(', ')}\n`);

  // I1
  const refs = rows.map((t) => t.ref);
  check('I1 every restaurant has its own database', new Set(refs).size === refs.length && rows.length === REFS.length, `${rows.length} resolved`);

  // I2
  for (let i = 0; i < rows.length; i++) {
    const a = rows[i];
    const b = rows[(i + 1) % rows.length];
    const r = await fetch(`${b.project_url}/rest/v1/financial_events?select=id&limit=1`, {
      headers: { apikey: a.anon_key, Authorization: `Bearer ${a.anon_key}` },
    });
    check(`I2 ${a.slug}'s key is refused by ${b.slug}'s database`, r.status === 401 || r.status === 403, `status ${r.status}`);
  }

  // I3
  for (const t of rows) {
    const h = { apikey: t.anon_key, Authorization: `Bearer ${t.anon_key}`, 'Content-Type': 'application/json' };
    const leaks: string[] = [];
    for (const table of FINANCE_TABLES) {
      const r = await fetch(`${t.project_url}/rest/v1/${table}?select=*&limit=5`, { headers: h });
      const n = await leaked(r);
      if (n) leaks.push(`${table}:${n}`);
    }
    for (const [fn, args] of FINANCE_RPCS) {
      const r = await fetch(`${t.project_url}/rest/v1/rpc/${fn}`, { method: 'POST', headers: h, body: JSON.stringify(args) });
      const n = await leaked(r);
      // period_profitability returns one all-zero row to anyone it can't see into.
      if (n && fn === 'period_profitability') {
        const again = (await (await fetch(`${t.project_url}/rest/v1/rpc/${fn}`, { method: 'POST', headers: h, body: JSON.stringify(args) })).json()) as Record<string, unknown>[];
        const anyMoney = again.some((row) => Object.entries(row).some(([k, v]) => k.endsWith('_cents') && Number(v) !== 0));
        if (anyMoney) leaks.push(`rpc ${fn}`);
      } else if (n) leaks.push(`rpc ${fn}:${n}`);
    }
    for (const bucket of BUCKETS) {
      const r = await fetch(`${t.project_url}/storage/v1/object/list/${bucket}`, { method: 'POST', headers: h, body: JSON.stringify({ prefix: '', limit: 5 }) });
      const n = await leaked(r);
      if (n) leaks.push(`bucket ${bucket}:${n}`);
    }
    check(`I3 ${t.slug}: an anonymous visitor reads no finance data (${FINANCE_TABLES.length} tables, ${FINANCE_RPCS.length} functions, ${BUCKETS.length} file buckets)`, leaks.length === 0, leaks.join(', '));
  }

  // I4
  for (let i = 0; i < rows.length; i++) {
    const t = rows[i];
    const other = rows[(i + 1) % rows.length];
    const tokens: [string, string | null][] = [
      ['no token', null],
      ['garbage token', 'not-a-real-token'],
      ['forged owner token', forgedOwnerToken(t.ref)],
      [`${other.slug}'s key`, other.anon_key],
    ];
    const bad: string[] = [];
    for (const [method, path] of API_ROUTES) {
      for (const [label, tok] of tokens) {
        const url = `${API}${path}${path.includes('?') ? '&' : '?'}slug=${encodeURIComponent(t.slug)}`;
        const r = await fetch(url, {
          method,
          headers: { ...(tok ? { Authorization: `Bearer ${tok}` } : {}), ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}) },
          body: method === 'POST' ? JSON.stringify({ slug: t.slug }) : undefined,
        });
        if (r.status !== 401 && r.status !== 403) bad.push(`${method} ${path} [${label}] → ${r.status}`);
      }
    }
    check(`I4 ${t.slug}: ${API_ROUTES.length} API routes refuse no / garbage / forged / other-restaurant tokens`, bad.length === 0, bad.slice(0, 6).join('; '));
  }

  // I5
  const r = await fetch(`${API}/api/ai/export-history?slug=no-such-restaurant-qa`, { headers: { Authorization: `Bearer ${forgedOwnerToken('x')}` } });
  const body = await r.text();
  check('I5 an unknown restaurant is a plain 404', r.status === 404 && !/supabase\.co|service|key/i.test(body), `status ${r.status}`);

  console.log(`\n${fails} failed`);
  if (fails) process.exitCode = 1;
}
main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
