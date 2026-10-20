// Merge one restaurant's records into a branch (another restaurant's database), keeping the
// branch's own records. Built for "put all of BBQ Tonight's data into the DHA branch".
//
//   npx tsx scripts/merge-restaurant-into-branch.ts <source-slug> <target-slug>            rehearsal (rolled back)
//   npx tsx scripts/merge-restaurant-into-branch.ts <source-slug> <target-slug> --apply    does it
//
// What happens, in ONE transaction on the target (all of it, or nothing):
//   * every source row is inserted with "on conflict do nothing" — rows the branch already has
//     (its one-time menu copy shares the same ids) are left alone;
//   * the target's own orders are renumbered after the source's, so both histories keep
//     unique order numbers; the order counter continues after both;
//   * auto-numbered tables (ledger, audit log, availability log) get new ids after the target's;
//   * every old in-database branch id of the source points at the target's own branch row;
//   * the source owner's account id is replaced by the target owner's (same email);
//   * stock: the target's stock + the source's stock, per ingredient and in branch_stock.
// Not copied: settings and receipt details, roles and the permission catalog (the target's own),
// portal logins (bound to the source's accounts), the source's in-database branch rows, unsent
// e-mail (outbox), open low-stock alerts, attention states and stale AI proposals.
// Database triggers are paused for the copy (session_replication_role = replica), so copying
// history doesn't re-post ledger entries, re-deduct stock or write audit rows of its own.
// The source restaurant is only read, never changed.
import { supabaseAdmin } from '../src/supabase';
import { mgmtClient } from '../src/mgmt';
import { getFreshConnection } from '../src/lib/supabaseOAuth';

const [SOURCE, TARGET] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const APPLY = process.argv.includes('--apply');
if (!SOURCE || !TARGET) throw new Error('Usage: merge-restaurant-into-branch.ts <source-slug> <target-slug> [--apply]');

type Row = Record<string, unknown>;

async function sqlFor(slug: string) {
  const { data: t } = await supabaseAdmin.from('tenants').select('id').eq('slug', slug).single();
  if (!t) throw new Error(`unknown restaurant ${slug}`);
  const { data: p } = await supabaseAdmin.from('tenant_projects').select('project_ref').eq('tenant_id', t.id).single();
  const conn = await getFreshConnection(t.id);
  const m = mgmtClient(conn.access_token);
  return async (q: string): Promise<Row[]> => {
    for (let attempt = 1; ; attempt++) {
      try {
        return (await m.runSql(String(p!.project_ref), q)) as Row[];
      } catch (e) {
        const msg = String((e as Error).message);
        if (attempt >= 4 || !/-> 5\d\d|522|timed out/i.test(msg)) throw e;
        await new Promise((r) => setTimeout(r, 4000));
      }
    }
  };
}

const SKIP = new Set([
  'business_settings', 'attendance_settings', 'purchasing_settings', 'roles', 'permission_catalog',
  'portals', 'portal_staff', 'branches', 'branch_menu_overrides', 'outbox', 'low_stock_events',
  'exception_states', 'ai_pending_actions', 'order_counter', 'invoice_counter', 'po_counter',
  'branch_stock', // merged by adding quantities, below
]);
const IDENTITY_OFFSET_TABLES = ['financial_events', 'audit_logs', 'availability_audit_log'];

function dollar(text: string): string {
  let tag = 'm';
  while (text.includes(`$${tag}$`)) tag += 'x';
  return `$${tag}$${text}$${tag}$`;
}
const lit = (v: string) => `'${v.replace(/'/g, "''")}'`;

async function main() {
  const src = await sqlFor(SOURCE);
  const dst = await sqlFor(TARGET);

  // ── Facts ──
  const tables = (await src(`select c.relname as t from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind = 'r' order by 1`)).map((r) => String(r.t));
  const dstTables = new Set((await dst(`select c.relname as t from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind = 'r'`)).map((r) => String(r.t)));
  const cols = await dst(`select table_name as t, column_name as c, is_generated as g, data_type as d
     from information_schema.columns where table_schema = 'public' order by ordinal_position`);
  const colsOf = (t: string) => cols.filter((c) => c.t === t && c.g !== 'ALWAYS').map((c) => String(c.c));
  const srcBranches = (await src(`select id::text as id from public.branches`)).map((r) => String(r.id));
  const [dstBranch] = await dst(`select id::text as id from public.branches order by is_default desc, created_at limit 1`);
  if (!dstBranch) throw new Error('target has no branch row');
  const [srcOwner] = await src(`select user_id::text as id, email from public.memberships where role = 'owner' and user_id is not null limit 1`);
  const [dstOwner] = srcOwner ? await dst(`select user_id::text as id from public.memberships where email = ${lit(String(srcOwner.email))} limit 1`) : [];
  const [srcMaxOrder] = await src(`select coalesce(max(order_number), 0) as n from public.orders`);
  const offsets: Record<string, number> = {};
  for (const t of IDENTITY_OFFSET_TABLES) {
    const [r] = await dst(`select coalesce(max(id), 0) as n from public.${t}`);
    offsets[t] = Number(r!.n);
  }
  const orderShift = Number(srcMaxOrder!.n);
  console.log(`branch ${dstBranch.id}; source branches ${srcBranches.length}; owner ${srcOwner ? 'mapped' : 'none'}; order shift +${orderShift}; id offsets ${JSON.stringify(offsets)}`);

  // Values to replace everywhere (uuids are unique, so a plain value swap is exact).
  const swap = new Map<string, string>(srcBranches.map((id) => [id, String(dstBranch.id)]));
  if (srcOwner?.id && dstOwner?.id) swap.set(String(srcOwner.id), String(dstOwner.id));
  const fix = (v: unknown): unknown => (typeof v === 'string' && swap.has(v) ? swap.get(v) : v);

  // ── Read every source table ──
  const statements: string[] = [];
  const plan: { t: string; rows: number }[] = [];
  for (const t of tables) {
    if (SKIP.has(t) || !dstTables.has(t)) continue;
    const names = colsOf(t);
    if (!names.length) continue;
    const [{ n }] = (await src(`select count(*)::int as n from public.${t}`)) as [{ n: number }];
    if (!n) continue;
    const rows: Row[] = [];
    for (let from = 0; from < n; from += 2000) {
      const part = await src(`select coalesce(json_agg(x), '[]'::json) as j from (select ${names.map((c) => `"${c}"`).join(', ')} from public.${t} order by 1 limit 2000 offset ${from}) x`);
      rows.push(...((part[0]!.j as Row[]) ?? []));
    }
    for (const r of rows) {
      for (const k of Object.keys(r)) r[k] = fix(r[k]);
      if (t in offsets && typeof r.id === 'number') r.id = r.id + offsets[t]!;
      if (t === 'memberships') r.user_id = r.user_id && r.user_id === dstOwner?.id ? r.user_id : null;
    }
    const list = names.map((c) => `"${c}"`).join(', ');
    const overriding = t in offsets ? ' overriding system value' : '';
    statements.push(
      `insert into public.${t} (${list})${overriding} select ${list} from json_populate_recordset(null::public.${t}, ${dollar(JSON.stringify(rows))}::json) on conflict do nothing;`,
    );
    plan.push({ t, rows: rows.length });
  }

  // ── Stock: the target's own stock plus the source's ──
  const srcStock = await src(`select id::text as id, stock_qty::text as q from public.inventory_items where stock_qty <> 0`);
  const stockJson = dollar(JSON.stringify(srcStock.map((r) => ({ id: r.id, q: Number(r.q) }))));
  const stockSql = `
    update public.inventory_items i set stock_qty = i.stock_qty + x.q
      from json_to_recordset(${stockJson}::json) as x(id uuid, q numeric) where i.id = x.id;
    update public.branch_stock b set stock_qty = b.stock_qty + x.q
      from json_to_recordset(${stockJson}::json) as x(id uuid, q numeric)
     where b.inventory_item_id = x.id and b.branch_id = '${dstBranch.id}';
    insert into public.branch_stock (branch_id, inventory_item_id, stock_qty)
    select '${dstBranch.id}', x.id, x.q from json_to_recordset(${stockJson}::json) as x(id uuid, q numeric)
     where not exists (select 1 from public.branch_stock b where b.inventory_item_id = x.id and b.branch_id = '${dstBranch.id}')
       and exists (select 1 from public.inventory_items i where i.id = x.id);`;

  // ── Counters ──
  const counterSql: string[] = [];
  for (const t of ['invoice_counter', 'po_counter']) {
    if (!dstTables.has(t)) continue;
    const numeric = cols.filter((c) => c.t === t && /int|numeric/.test(String(c.d)) && c.c !== 'id').map((c) => String(c.c));
    for (const c of numeric) {
      const [r] = await src(`select max("${c}") as n from public.${t}`);
      if (r?.n != null) counterSql.push(`update public.${t} set "${c}" = greatest("${c}", ${Number(r.n)});`);
    }
  }

  const before = `select json_object_agg(t, n) as counts from (select 'orders' as t, count(*) as n from public.orders union all select 'order_lines', count(*) from public.order_lines union all select 'payments', count(*) from public.payments union all select 'financial_events', count(*) from public.financial_events union all select 'stock_ledger', count(*) from public.stock_ledger union all select 'expenses', count(*) from public.expenses union all select 'purchase_orders', count(*) from public.purchase_orders union all select 'supplier_invoices', count(*) from public.supplier_invoices union all select 'audit_logs', count(*) from public.audit_logs union all select 'feedback', count(*) from public.feedback) c`;
  const summary = `select json_build_object(
      'counts', (${before}),
      'order_numbers', (select min(order_number) || '-' || max(order_number) from public.orders),
      'duplicate_order_numbers', (select count(*) from (select order_number from public.orders group by 1 having count(*) > 1) d),
      'next_order', (select next_number from public.order_counter limit 1),
      'stock_total', (select sum(stock_qty)::text from public.inventory_items),
      'branch_stock_total', (select sum(stock_qty)::text from public.branch_stock),
      'net_sales_cents', (select sum(signed_cents) from public.financial_events where category::text = 'sales')
    ) as s`;

  const [pre] = await dst(summary);
  console.log('before:', JSON.stringify(pre!.s));
  const body = [
    `set local session_replication_role = replica;`,
    // The branch's own orders move after the source's numbers (order_lines etc. link by id, not number).
    orderShift ? `update public.orders set order_number = order_number + ${orderShift};` : '',
    ...statements,
    stockSql,
    `update public.order_counter set next_number = (select coalesce(max(order_number), 0) + 1 from public.orders);`,
    ...counterSql,
    ...IDENTITY_OFFSET_TABLES.map((t) => `select setval(pg_get_serial_sequence('public.${t}', 'id'), greatest((select coalesce(max(id), 0) from public.${t}), 1));`),
    `set local session_replication_role = origin;`,
  ].join('\n');
  const sql = `begin;\n${body}\n${summary};\n${APPLY ? 'commit;' : 'rollback;'}`;
  console.log(`tables to copy: ${plan.length}, rows: ${plan.reduce((s, p) => s + p.rows, 0)}, sql size: ${(sql.length / 1024).toFixed(0)} KB`);
  const res = await dst(sql);
  const out = res[res.length - 1] as Row | undefined;
  console.log(APPLY ? 'APPLIED. after:' : 'REHEARSAL (rolled back). would be:', JSON.stringify(out?.s ?? res));
  if (APPLY) {
    const [post] = await dst(summary);
    console.log('re-read after commit:', JSON.stringify(post!.s));
  }
}

main().catch((e) => {
  console.error('FAILED:', String((e as Error).message ?? e).slice(0, 600));
  process.exit(1);
});
