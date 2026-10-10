// Unit check for branchFilteringFetch (lib/tenantAdmin.ts): an owner viewing one branch reads
// branch tables through the service key, so the client itself must add the branch filter.
//   npx tsx scripts/test-branch-fetch.ts
import { branchFilteringFetch } from '../src/lib/tenantAdmin';

const DHA = '11111111-1111-4111-8111-111111111111';
let seen: { url: string; method: string } | null = null;
const fake = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  seen = { url, method: (init?.method ?? 'GET').toUpperCase() };
  return new Response('[]');
}) as typeof fetch;
const f = branchFilteringFetch([DHA, 'not-a-uuid'], fake);
const base = 'https://x.supabase.co/rest/v1';
let fails = 0;
async function check(name: string, url: string, init: RequestInit | undefined, expectFilter: boolean) {
  await f(url, init);
  const has = new URL(seen!.url).searchParams.get('branch_id') === `in.(${DHA})`;
  const ok = has === expectFilter;
  if (!ok) fails++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`);
}

async function main() {
await check('F1 reading orders adds the branch filter', `${base}/orders?select=id,total_cents&status=eq.paid`, undefined, true);
await check('F2 reading expenses adds it too', `${base}/expenses?select=*`, { method: 'GET' }, true);
await check('F3 shared tables (menu) are left alone', `${base}/menu_items?select=*`, undefined, false);
await check('F4 writes are left alone (the database fills the branch)', `${base}/orders`, { method: 'POST', body: '{}' }, false);
await check('F5 RPC reports are left alone (the header scopes them)', `${base}/rpc/branch_summary`, { method: 'POST' }, false);
await f(`${base}/orders?branch_id=eq.${DHA}`, undefined);
const kept = new URL(seen!.url).searchParams.getAll('branch_id');
if (kept.length === 1) console.log('PASS F6 an explicit branch filter is kept, not doubled');
else { fails++; console.log('FAIL F6', kept); }
console.log(`\n${fails} failed`);
process.exit(fails ? 1 : 0);
}
void main();
