// Restaurant currency (tenant migration 0097): anyone can read it (the guest
// menu formats prices), only settings.update / owner can change it, only the
// supported two-decimal currencies, and every change is audited. Rolled back.
//
// Usage (from apps/api):  npx tsx scripts/test-currency.ts [project_ref]
import { supabaseAdmin } from '../src/supabase';
import { getFreshConnection } from '../src/lib/supabaseOAuth';
import { env } from '../src/env';

const REF = process.argv[2] ?? 'uhfwoftjecgjemvwqdbp';
// PRE_SQL=<file>: run a migration first inside the same rolled-back transaction (rehearsal).
const PRE = process.env.PRE_SQL ? require('node:fs').readFileSync(process.env.PRE_SQL, 'utf8') + String.fromCharCode(10) : '';
const claims = (sub: string, perms: string[], role = 'staff') =>
  JSON.stringify({ role: 'authenticated', sub, app_metadata: { kind: 'portal', role, permissions: perms } });
const OWNER = claims('00000000-0000-0000-0000-0000000000a1', ['*'], 'owner');
const WAITER = claims('00000000-0000-0000-0000-00000000aa17', ['orders.view'], 'waiter');

const SQL = String.raw`
do $$
declare res text := ''; fails int := 0; v text; n int;
begin
  perform set_config('request.jwt.claims', '${OWNER}', true); set local role authenticated;
  v := public.set_currency('pkr');
  reset role;
  select count(*) into n from public.audit_logs where action = 'settings.currency_changed' and created_at > now() - interval '1 minute';
  if v = 'PKR' and (select currency_code from public.business_settings limit 1) = 'PKR' then
    res := res || format(E'PASS C1 the owner sets the currency (lower case accepted) as PKR; audited rows: %s\n', n);
  else fails := fails + 1; res := res || format(E'FAIL C1 got %s\n', v); end if;

  perform set_config('request.jwt.claims', '${OWNER}', true); set local role authenticated;
  begin
    perform public.set_currency('JPY');
    reset role; fails := fails + 1; res := res || E'FAIL C2 JPY (0 decimals) was accepted\n';
  exception when check_violation then reset role; res := res || E'PASS C2 a currency without two decimals (JPY) is refused\n'; end;

  perform set_config('request.jwt.claims', '${WAITER}', true); set local role authenticated;
  begin
    perform public.set_currency('USD');
    reset role; fails := fails + 1; res := res || E'FAIL C3 a waiter changed the currency\n';
  exception when insufficient_privilege then reset role; res := res || E'PASS C3 a waiter cannot change the currency\n'; end;

  perform set_config('request.jwt.claims', '{"role":"anon"}', true); set local role anon;
  v := public.get_currency();
  reset role;
  if v = 'PKR' then res := res || E'PASS C4 a guest (not signed in) can read the currency for the menu\n';
  else fails := fails + 1; res := res || format(E'FAIL C4 anon read %s\n', v); end if;

  begin
    update public.business_settings set currency_code = 'rupees';
    fails := fails + 1; res := res || E'FAIL C5 an invalid code was stored\n';
  exception when check_violation then res := res || E'PASS C5 the database refuses a malformed currency code\n'; end;

  raise exception E'RESULTS (rolled back) — % failed\n%', fails, res;
end $$;
`;

async function main() {
  const { data: proj } = await supabaseAdmin.from('tenant_projects').select('tenant_id').eq('project_ref', REF).single();
  const { data: conns } = await supabaseAdmin.from('supabase_connections').select('tenant_id').eq('tenant_id', proj!.tenant_id);
  const token = conns && conns.length ? (await getFreshConnection(proj!.tenant_id)).access_token : env.SUPABASE_ACCESS_TOKEN;
  const r = await fetch(`https://api.supabase.com/v1/projects/${REF}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: PRE + SQL }),
  });
  const text = await r.text();
  const m = text.match(/RESULTS \(rolled back\) — (\d+) failed\\n([\s\S]*?)"}/);
  if (!m) {
    console.error(text.slice(0, 1500));
    process.exitCode = 1;
    return;
  }
  console.log(m[2].replace(/\\n/g, '\n').replace(/\\"/g, '"'));
  console.log(`${m[1]} failed`);
  if (m[1] !== '0') process.exitCode = 1;
}
main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
