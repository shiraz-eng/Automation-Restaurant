import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { createTenantServerClient } from '@/lib/supabase/tenant-server';
import { loadTenantCurrency } from '@/lib/currencyServer';
import { gatePortalPage, can } from '@/lib/permissions';
import { getTenantEntitlement } from '@/lib/entitlements';
import { PlanUpgradePaywall } from '@/components/PlanUpgradePaywall';
import { SectionReportButtons } from '@/components/SectionReportButtons';
import { formatCents } from '@/lib/format';
import { resolveFinancePeriod, PERIOD_LABELS, todayIn } from '@/lib/financePeriod';
import { FoodCostTarget } from './FoodCostTarget';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Finance' };

type SummaryRow = { category: string; net_cents: number; increase_cents: number; decrease_cents: number; events: number };
type AgingRow = {
  supplier_id: string; supplier_name: string; invoices: number; current_cents: number; d1_30_cents: number;
  d31_60_cents: number; d61_90_cents: number; d90_plus_cents: number; total_cents: number;
};
type WatchRow = {
  recipe_id: string; name: string; price_cents: number; cost_cents: number; food_cost_pct: number | null;
  previous_cost_cents: number | null; change_pts: number | null; target_pct: number; over_target: boolean; rising: boolean;
};

function bucket(rows: SummaryRow[]) {
  const by = (c: string) => rows.find((r) => r.category === c);
  const n = (v: unknown) => Number(v ?? 0);
  const revenue = n(by('revenue')?.net_cents);
  const cogs = n(by('cogs')?.net_cents);
  const expenses = n(by('expense')?.net_cents);
  return {
    revenue,
    cogs,
    gross: revenue - cogs,
    expenses,
    operating: revenue - cogs - expenses,
    paymentsIn: n(by('payment')?.increase_cents),
    refunds: n(by('payment')?.decrease_cents),
    cashMovements: n(by('cash')?.net_cents),
    waste: n(by('waste')?.net_cents),
    payableAdded: n(by('payable')?.increase_cents),
    payablePaid: n(by('payable')?.decrease_cents),
  };
}

export default async function FinanceOverviewPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ period?: string; from?: string; to?: string }>;
}) {
  const { slug } = await params;
  const sp = await searchParams;
  const t = await createTenantServerClient(slug);
  if (!t) notFound();
  // Money on this server-rendered page uses the restaurant's currency.
  await loadTenantCurrency(t.client);
  const { role, perms } = await gatePortalPage(t.client, slug, 'finance.view');
  const ent = await getTenantEntitlement(t.client, t.config.tier);
  if (!ent.isEntitled('accounting.finance')) {
    return <PlanUpgradePaywall slug={slug} featureKey="accounting.finance" currentTier={ent.tier} />;
  }

  const canCogs = can(perms, role, 'finance.view_cogs') || can(perms, role, 'finance.view_profit') || can(perms, role, 'inventory.view_cost');
  const canPayables = can(perms, role, 'payables.view') || can(perms, role, 'payables.manage') || can(perms, role, 'finance.view');
  const canSetTarget = can(perms, role, 'finance.manage_costs') || role === 'owner' || role === 'manager';

  const { data: settings } = await t.client.from('business_settings').select('timezone, currency_code, food_cost_target_bps').maybeSingle();
  const tz = settings?.timezone ?? 'UTC';
  const range = resolveFinancePeriod(sp, tz);
  const today = todayIn(tz);
  const twoWeeksAgo = new Date(Date.parse(`${today}T00:00:00Z`) - 14 * 86_400_000).toISOString().slice(0, 10);

  const [cur, prev, payableRes, agingRes, watchRes, holdsRes, awaitingRes, unmatchedRes, salesDaysRes, closedDaysRes] = await Promise.all([
    t.client.rpc('ledger_summary', { p_from: range.from, p_to: range.to }),
    t.client.rpc('ledger_summary', { p_from: range.prevFrom, p_to: range.prevTo }),
    canPayables ? t.client.rpc('supplier_payable') : Promise.resolve({ data: [] }),
    canPayables ? t.client.rpc('payables_aging') : Promise.resolve({ data: [] }),
    canCogs ? t.client.rpc('food_cost_watch', { p_days: 30 }) : Promise.resolve({ data: [] }),
    t.client.from('supplier_payment_holds').select('id', { count: 'exact', head: true }).eq('status', 'open'),
    t.client.from('expenses').select('id', { count: 'exact', head: true }).eq('status', 'submitted'),
    t.client.from('supplier_invoices').select('id', { count: 'exact', head: true }).eq('status', 'received'),
    t.client.from('financial_events').select('business_date').eq('category', 'revenue').gte('business_date', twoWeeksAgo).lt('business_date', today).limit(5000),
    t.client.from('daily_closings').select('business_date').eq('status', 'closed').gte('business_date', twoWeeksAgo),
  ]);

  const now = bucket((cur.data as SummaryRow[] | null) ?? []);
  const before = bucket((prev.data as SummaryRow[] | null) ?? []);
  const targetPct = (settings?.food_cost_target_bps ?? 3000) / 100;
  const foodPct = now.revenue > 0 ? Math.round((now.cogs / now.revenue) * 1000) / 10 : null;
  const payable = ((payableRes.data ?? []) as { outstanding_cents: number; overdue_cents: number }[]).reduce(
    (s, r) => ({ outstanding: s.outstanding + Number(r.outstanding_cents), overdue: s.overdue + Number(r.overdue_cents) }),
    { outstanding: 0, overdue: 0 },
  );
  const aging = (agingRes.data as AgingRow[] | null) ?? [];
  const agingTotals = aging.reduce(
    (s, r) => ({
      current: s.current + Number(r.current_cents), d30: s.d30 + Number(r.d1_30_cents), d60: s.d60 + Number(r.d31_60_cents),
      d90: s.d90 + Number(r.d61_90_cents), d90p: s.d90p + Number(r.d90_plus_cents), total: s.total + Number(r.total_cents),
    }),
    { current: 0, d30: 0, d60: 0, d90: 0, d90p: 0, total: 0 },
  );
  const watch = ((watchRes.data as WatchRow[] | null) ?? []).filter((w) => w.over_target || (w.rising && (w.change_pts ?? 0) >= 1));
  const closed = new Set(((closedDaysRes.data ?? []) as { business_date: string }[]).map((d) => d.business_date));
  const unclosed = [...new Set(((salesDaysRes.data ?? []) as { business_date: string }[]).map((d) => d.business_date))]
    .filter((d) => !closed.has(d))
    .sort();

  const base = `/r/${slug}`;
  const ledger = (category: string) => `${base}/finance/ledger?category=${category}&from=${range.from}&to=${range.to}`;
  const attention = [
    unclosed.length > 0 && { text: `${unclosed.length} day(s) with sales not closed yet (${unclosed.slice(-3).join(', ')})`, href: `${base}/close` },
    (holdsRes.count ?? 0) > 0 && { text: `${holdsRes.count} supplier-invoice exception(s) to resolve`, href: `${base}/purchasing` },
    (unmatchedRes.count ?? 0) > 0 && { text: `${unmatchedRes.count} supplier invoice(s) waiting for the 3-way match`, href: `${base}/purchasing` },
    (awaitingRes.count ?? 0) > 0 && { text: `${awaitingRes.count} expense(s) awaiting approval`, href: `${base}/expenses` },
    payable.overdue > 0 && { text: `${formatCents(payable.overdue)} owed to suppliers is overdue`, href: `${base}/purchasing` },
    watch.length > 0 && { text: `${watch.length} dish(es) over the ${targetPct}% food-cost target or rising`, href: '#food-cost' },
  ].filter(Boolean) as { text: string; href: string }[];

  return (
    <div className="space-y-6 max-w-5xl">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-black">Finance</h1>
          <p className="text-muted text-xs mt-1">
            Profit, cash and what you owe — every figure comes from the financial ledger and links to the entries behind it.
          </p>
        </div>
        <SectionReportButtons slug={slug} restaurantName={t.config.restaurantName} domain="finance" label="Finance" />
      </div>

      <nav className="flex flex-wrap gap-1.5 text-xs">
        {(Object.keys(PERIOD_LABELS) as (keyof typeof PERIOD_LABELS)[]).map((p) => (
          <Link
            key={p}
            href={`${base}/finance?period=${p}`}
            className={`rounded-full border px-3 py-1 ${range.period === p ? 'border-primary bg-primary text-primary-fg' : 'border-border'}`}
          >
            {PERIOD_LABELS[p]}
          </Link>
        ))}
        <span className="self-center text-muted ml-1">
          {range.from === range.to ? range.from : `${range.from} → ${range.to}`} · vs {range.prevFrom} → {range.prevTo}
        </span>
      </nav>

      <section className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Kpi label="Net sales" cents={now.revenue} prev={before.revenue} href={ledger('revenue')} />
        {canCogs && <Kpi label="Food cost (COGS)" cents={now.cogs} prev={before.cogs} href={ledger('cogs')} invert />}
        {canCogs && <Kpi label="Gross profit" cents={now.gross} prev={before.gross} sub={now.revenue > 0 ? `${Math.round((now.gross / now.revenue) * 1000) / 10}% margin` : undefined} />}
        <Kpi label="Operating expenses" cents={now.expenses} prev={before.expenses} href={ledger('expense')} invert sub="approved, dated in period" />
        {canCogs && (
          <Kpi
            label="Operating profit"
            cents={now.operating}
            prev={before.operating}
            sub={now.revenue > 0 ? `${Math.round((now.operating / now.revenue) * 1000) / 10}% of sales` : undefined}
            tone={now.operating < 0 ? 'bad' : 'good'}
          />
        )}
        <Kpi label="Payments received" cents={now.paymentsIn} prev={before.paymentsIn} href={ledger('payment')} sub={now.refunds ? `${formatCents(now.refunds)} refunded / voided` : undefined} />
        {canPayables && (
          <Kpi label="Owed to suppliers" cents={payable.outstanding} sub={payable.overdue ? `${formatCents(payable.overdue)} overdue` : 'nothing overdue'} href={ledger('payable')} tone={payable.overdue ? 'bad' : undefined} />
        )}
        {canCogs && (
          <div className="rounded-lg border border-border bg-surface p-3">
            <p className="text-[11px] text-muted">Food cost %</p>
            <p className={`text-lg font-black ${foodPct != null && foodPct > targetPct ? 'text-danger' : 'text-ok'}`}>{foodPct == null ? '—' : `${foodPct}%`}</p>
            <p className="text-[11px] text-muted">target {targetPct}%</p>
          </div>
        )}
      </section>

      {attention.length > 0 && (
        <section className="rounded-lg border border-warn/40 bg-warn/10 p-3">
          <p className="text-xs font-bold text-warn mb-1.5">Needs attention</p>
          <ul className="space-y-1 text-xs">
            {attention.map((a) => (
              <li key={a.text}>
                <Link href={a.href} className="hover:underline">
                  ● {a.text}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
        {[
          ['finance/ledger', 'Ledger', 'Every money event, traceable'],
          ['expenses', 'Expenses', 'Record, approve, pay'],
          ['purchasing', 'Payables & invoices', 'Match, approve, pay suppliers'],
          ['close', 'Cash & day close', 'Movements, counts, lock the day'],
          ['recipes', 'Recipes & food cost', 'Costed recipes'],
          ['', 'Performance', 'Charts and trends'],
          ['exports', 'Report history', 'Saved PDFs and exports'],
          ['audit', 'Audit log', 'Who changed what'],
        ].map(([path, title, desc]) => (
          <Link key={title} href={`${base}${path ? `/${path}` : ''}`} className="rounded-lg border border-border bg-surface p-3 hover:border-primary">
            <p className="font-bold">{title}</p>
            <p className="text-muted">{desc}</p>
          </Link>
        ))}
      </section>

      {canPayables && (
        <section>
          <h2 className="font-bold text-sm mb-2">Supplier payables aging</h2>
          {aging.length === 0 ? (
            <p className="text-xs text-muted">Nothing owed to suppliers.</p>
          ) : (
            <div className="overflow-x-auto rounded-lg border border-border">
              <table className="w-full text-left text-xs">
                <thead className="text-muted border-b border-border">
                  <tr>
                    <th className="p-2.5 font-semibold">Supplier</th>
                    <th className="p-2.5 font-semibold text-right">Not yet due</th>
                    <th className="p-2.5 font-semibold text-right">1–30 days</th>
                    <th className="p-2.5 font-semibold text-right">31–60</th>
                    <th className="p-2.5 font-semibold text-right">61–90</th>
                    <th className="p-2.5 font-semibold text-right">90+</th>
                    <th className="p-2.5 font-semibold text-right">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {aging.map((r) => (
                    <tr key={r.supplier_id} className="border-b border-border/60 last:border-0">
                      <td className="p-2.5 font-semibold">
                        {r.supplier_name} <span className="text-muted font-normal">· {r.invoices}</span>
                      </td>
                      <Money c={r.current_cents} />
                      <Money c={r.d1_30_cents} warn />
                      <Money c={r.d31_60_cents} warn />
                      <Money c={r.d61_90_cents} warn />
                      <Money c={r.d90_plus_cents} warn />
                      <Money c={r.total_cents} bold />
                    </tr>
                  ))}
                </tbody>
                <tfoot className="border-t border-border bg-main/60 font-bold">
                  <tr>
                    <td className="p-2.5">Total</td>
                    <Money c={agingTotals.current} />
                    <Money c={agingTotals.d30} warn />
                    <Money c={agingTotals.d60} warn />
                    <Money c={agingTotals.d90} warn />
                    <Money c={agingTotals.d90p} warn />
                    <Money c={agingTotals.total} bold />
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
        </section>
      )}

      {canCogs && (
        <section id="food-cost">
          <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
            <h2 className="font-bold text-sm">Food cost watch</h2>
            <FoodCostTarget targetPct={targetPct} canEdit={canSetTarget} />
          </div>
          {watch.length === 0 ? (
            <p className="text-xs text-muted">Every costed dish is within the {targetPct}% target and no recipe cost has risen in the last 30 days.</p>
          ) : (
            <div className="overflow-x-auto rounded-lg border border-border">
              <table className="w-full text-left text-xs">
                <thead className="text-muted border-b border-border">
                  <tr>
                    <th className="p-2.5 font-semibold">Dish</th>
                    <th className="p-2.5 font-semibold text-right">Price</th>
                    <th className="p-2.5 font-semibold text-right">Cost now</th>
                    <th className="p-2.5 font-semibold text-right">Food cost</th>
                    <th className="p-2.5 font-semibold text-right">Change (30 days)</th>
                    <th className="p-2.5 font-semibold text-right">Margin</th>
                  </tr>
                </thead>
                <tbody>
                  {watch.map((w) => (
                    <tr key={w.recipe_id} className="border-b border-border/60 last:border-0">
                      <td className="p-2.5 font-semibold">{w.name}</td>
                      <Money c={w.price_cents} />
                      <Money c={w.cost_cents} />
                      <td className={`p-2.5 text-right font-mono ${w.over_target ? 'text-danger font-bold' : ''}`}>
                        {w.food_cost_pct == null ? '—' : `${Number(w.food_cost_pct)}%`}
                      </td>
                      <td className={`p-2.5 text-right font-mono ${w.rising ? 'text-danger' : 'text-muted'}`}>
                        {w.change_pts == null ? '—' : `${Number(w.change_pts) > 0 ? '+' : ''}${Number(w.change_pts)} pts`}
                      </td>
                      <Money c={w.price_cents - w.cost_cents} bold />
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      <p className="text-[11px] text-muted">
        Operating profit here = net sales − food cost − approved expenses dated in this period. (Restaurant Performance on the dashboard
        subtracts every expense up to the period end, as chosen earlier, so the two can differ.)
      </p>
    </div>
  );
}

function Kpi({
  label, cents, prev, href, sub, invert, tone,
}: {
  label: string; cents: number; prev?: number; href?: string; sub?: string; invert?: boolean; tone?: 'good' | 'bad';
}) {
  const delta = prev != null && prev !== 0 ? Math.round(((cents - prev) / Math.abs(prev)) * 1000) / 10 : null;
  const better = delta == null ? null : invert ? delta < 0 : delta > 0;
  const body = (
    <div className="rounded-lg border border-border bg-surface p-3 h-full hover:border-primary/60">
      <p className="text-[11px] text-muted">{label}</p>
      <p className={`text-lg font-black font-mono ${tone === 'bad' ? 'text-danger' : tone === 'good' ? 'text-ok' : ''}`}>{formatCents(cents)}</p>
      <p className="text-[11px] text-muted">
        {delta != null && <span className={better ? 'text-ok' : 'text-danger'}>{delta > 0 ? '▲' : delta < 0 ? '▼' : '●'} {Math.abs(delta)}% </span>}
        {sub ?? (prev != null ? `prev ${formatCents(prev)}` : '')}
      </p>
    </div>
  );
  return href ? <Link href={href}>{body}</Link> : body;
}

function Money({ c, warn, bold }: { c: number; warn?: boolean; bold?: boolean }) {
  const v = Number(c);
  return (
    <td className={`p-2.5 text-right font-mono ${warn && v > 0 ? 'text-danger' : ''} ${bold ? 'font-bold' : ''} ${v === 0 ? 'text-muted' : ''}`}>
      {formatCents(v)}
    </td>
  );
}
