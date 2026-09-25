// Restaurant Performance access tests (tenant migration 0072).
//
// Runs the Dashboard's performance RPCs as a finance portal WITHOUT
// orders.view (must work) and as a kitchen portal (must be refused), in one
// DO block that rolls back.
//
// Usage (from apps/api):  npx tsx scripts/test-performance-access.ts [project_ref]
import { supabaseAdmin } from '../src/supabase';
import { getFreshConnection } from '../src/lib/supabaseOAuth';
import { env } from '../src/env';

const REF = process.argv[2] ?? 'uhfwoftjecgjemvwqdbp';

const SQL = String.raw`
do $$
declare res text := ''; fails int := 0; v_n int;
  finance_claims text := '{"role":"authenticated","sub":"00000000-0000-0000-0000-00000000beef","app_metadata":{"kind":"portal","portal_id":"11111111-1111-1111-1111-111111111111","permissions":["analytics.view","analytics.export","finance.view","finance.view_profit","finance.view_cogs","finance.create_expense"]}}';
  kitchen_claims text := '{"role":"authenticated","sub":"00000000-0000-0000-0000-00000000cafe","app_metadata":{"kind":"portal","portal_id":"22222222-2222-2222-2222-222222222222","permissions":["kitchen.view","kitchen.update_status"]}}';
begin
  perform set_config('request.jwt.claims', finance_claims, true);
  begin
    select count(*) into v_n from public.sales_by_day(current_date - 7, current_date);
    select count(*) into v_n from public.revenue_by_category(now() - interval '7 days', now());
    select count(*) into v_n from public.payment_mix(now() - interval '7 days', now());
    select count(*) into v_n from public.feedback_summary(now() - interval '7 days', now());
    select count(*) into v_n from public.period_profitability(now() - interval '7 days', now());
    select count(*) into v_n from public.item_profitability(now() - interval '7 days', now());
    res := res || E'PASS P1 finance portal without "View orders" loads every performance report\n';
  exception when others then fails := fails + 1; res := res || 'FAIL P1 ' || sqlerrm || E'\n'; end;

  perform set_config('request.jwt.claims', kitchen_claims, true);
  begin
    perform public.sales_by_day(current_date - 7, current_date);
    fails := fails + 1; res := res || E'FAIL P3 kitchen portal read sales totals\n';
  exception when insufficient_privilege then res := res || E'PASS P3 kitchen portal refused sales totals\n'; end;

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
    body: JSON.stringify({ query: SQL }),
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
