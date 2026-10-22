import Link from 'next/link';
import type { SupabaseClient } from '@supabase/supabase-js';
import { Banknote, ChartColumn, Clock, FileText, Receipt, RotateCcw, TrendingDown, TrendingUp, Truck, Wallet, type LucideIcon } from 'lucide-react';
import { formatCents } from '@/lib/format';
import { addDays, monthEnd, monthsInRange, rangeLabel, type ResolvedFinancePeriod } from '@/lib/financePeriod';
import {
  FOCUS_RING, ModuleKpiCard, ModuleKpiGrid, ModuleSkeleton, ModuleUnavailableKpi, accentTile, percentChange, type ModuleAccent,
} from '@/components/module/ModuleLanding';
import { RevenueExpenseChart, type RevenueExpenseBucket } from './RevenueExpenseChart';

/**
 * The Finance landing page's data sections. Each is an async server component
 * that reads the financial ledger with the signed-in user's own Supabase client
 * (RLS: finance.view) and streams in behind its own <Suspense> skeleton.
 */

type SummaryRow = { category: string; net_cents: number; increase_cents: number; decrease_cents: number; events: number };
type LedgerEvent = {
  id: number; event_type: string; category: string; sign: number; amount_cents: number; occurred_at: string;
  business_date: string; source_table: string; supplier_id: string | null; payment_method: string | null; details: Record<string, unknown>;
};
export type Access = { canCogs: boolean; canPayables: boolean };

function totals(rows: SummaryRow[] | null) {
  const by = (c: string) => (rows ?? []).find((r) => r.category === c);
  const revenue = Number(by('revenue')?.net_cents ?? 0);
  const cogs = Number(by('cogs')?.net_cents ?? 0);
  const expenses = Number(by('expense')?.net_cents ?? 0);
  return { revenue, cogs, expenses, operating: revenue - cogs - expenses, events: (rows ?? []).reduce((s, r) => s + Number(r.events), 0) };
}

// ── KPI cards ──────────────────────────────────────────────────────────────

export function KpiSkeleton() {
  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4" aria-busy="true" aria-label="Loading figures">
      {[0, 1, 2, 3].map((i) => (
        <ModuleSkeleton key={i} className="h-[5.75rem]" />
      ))}
    </div>
  );
}

export async function FinanceKpis({ client, range, access, base }: { client: SupabaseClient; range: ResolvedFinancePeriod; access: Access; base: string }) {
  const [cur, prev, payableRes] = await Promise.all([
    client.rpc('ledger_summary', { p_from: range.from, p_to: range.to }),
    client.rpc('ledger_summary', { p_from: range.prevFrom, p_to: range.prevTo }),
    access.canPayables ? client.rpc('supplier_payable') : Promise.resolve({ data: [], error: null }),
  ]);
  if (cur.error) return <SectionError what="the finance figures" message={cur.error.message} />;

  const now = totals(cur.data as SummaryRow[] | null);
  // A failed comparison query hides the change badges rather than comparing with zero.
  const before = prev.error ? null : totals(prev.data as SummaryRow[] | null);
  const compareLabel = `vs ${rangeLabel(range.prevFrom, range.prevTo)}`;
  const ledger = (category: string) => `${base}/finance/ledger?category=${category}&period=custom&from=${range.from}&to=${range.to}`;
  const payable = payableRes.error
    ? null
    : ((payableRes.data ?? []) as { outstanding_cents: number; overdue_cents: number }[]).reduce(
        (s, r) => ({ outstanding: s.outstanding + Number(r.outstanding_cents), overdue: s.overdue + Number(r.overdue_cents) }),
        { outstanding: 0, overdue: 0 },
      );

  return (
    <div className="space-y-2">
      <ModuleKpiGrid>
        <ModuleKpiCard
          icon={TrendingUp}
          accent="emerald"
          label="Total Revenue"
          value={formatCents(now.revenue)}
          delta={percentChange(now.revenue, before?.revenue)}
          compareLabel={compareLabel}
          footnote="Net sales"
          href={ledger('revenue')}
        />
        <ModuleKpiCard
          icon={TrendingDown}
          accent="rose"
          label="Total Expenses"
          value={formatCents(now.expenses)}
          delta={percentChange(now.expenses, before?.expenses)}
          goodWhenUp={false}
          compareLabel={compareLabel}
          footnote="Approved operating expenses"
          href={ledger('expense')}
        />
        {access.canCogs && (
          <ModuleKpiCard
            icon={Wallet}
            accent="blue"
            label="Operating Profit"
            value={formatCents(now.operating)}
            valueTone={now.operating < 0 ? 'danger' : undefined}
            delta={percentChange(now.operating, before?.operating)}
            compareLabel={compareLabel}
            footnote={now.revenue > 0 ? `${Math.round((now.operating / now.revenue) * 1000) / 10}% of sales, after food cost` : 'Sales − food cost − expenses'}
            href={`${base}/finance/overview?period=custom&from=${range.from}&to=${range.to}`}
          />
        )}
        {access.canPayables &&
          (payable ? (
            <ModuleKpiCard
              icon={Banknote}
              accent="amber"
              label="Outstanding Payables"
              value={formatCents(payable.outstanding)}
              valueTone={payable.overdue > 0 ? 'danger' : undefined}
              footnote={payable.overdue > 0 ? `Owed to suppliers · ${formatCents(payable.overdue)} overdue` : 'Owed to suppliers · nothing overdue'}
              href={ledger('payable')}
            />
          ) : (
            <ModuleUnavailableKpi label="Outstanding Payables" message={payableRes.error?.message ?? 'Not available'} />
          ))}
      </ModuleKpiGrid>
      {now.events === 0 && <p className="text-xs text-muted">No ledger activity in {rangeLabel(range.from, range.to)} yet — figures will appear as orders, payments and expenses are recorded.</p>}
    </div>
  );
}

function SectionError({ what, message }: { what: string; message: string }) {
  return (
    <div role="alert" className="rounded-2xl border border-danger/40 bg-danger/10 p-4 text-xs text-danger">
      Could not load {what}: {message}
    </div>
  );
}

// ── Revenue vs expenses ────────────────────────────────────────────────────

const shortDay = (ymd: string) => new Date(`${ymd}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });

/** Days for up to a month, weeks up to ~4 months, calendar months beyond — never more than ~31 bars. */
function chartBuckets(from: string, to: string): { from: string; to: string; label: string; range: string; grain: string }[] {
  const days: string[] = [];
  for (let d = from; d <= to && days.length <= 120; d = addDays(d, 1)) days.push(d);
  if (days.length <= 31) return days.map((d) => ({ from: d, to: d, label: shortDay(d), range: rangeLabel(d, d), grain: 'Daily' }));
  if (days.length <= 120) {
    const out = [];
    for (let s = from; s <= to; s = addDays(s, 7)) {
      const e = addDays(s, 6) < to ? addDays(s, 6) : to;
      out.push({ from: s, to: e, label: shortDay(s), range: rangeLabel(s, e), grain: 'Weekly' });
    }
    return out;
  }
  const months = monthsInRange(from, to).slice(-31);
  const multiYear = from.slice(0, 4) !== to.slice(0, 4);
  return months.map((ym) => {
    const s = `${ym}-01` < from ? from : `${ym}-01`;
    const e = monthEnd(`${ym}-01`) > to ? to : monthEnd(`${ym}-01`);
    const label = new Date(`${ym}-01T00:00:00Z`).toLocaleDateString('en-GB', { month: 'short', ...(multiYear ? { year: '2-digit' } : {}), timeZone: 'UTC' });
    return { from: s, to: e, label, range: rangeLabel(s, e), grain: 'Monthly' };
  });
}

export async function RevenueExpenseSection({ client, range, access }: { client: SupabaseClient; range: ResolvedFinancePeriod; access: Access }) {
  const plan = chartBuckets(range.from, range.to);
  // One ledger_summary per bar: exactly the KPI cards' definitions, aggregated in the database.
  const results = await Promise.all(plan.map((b) => client.rpc('ledger_summary', { p_from: b.from, p_to: b.to })));
  const failed = results.find((r) => r.error);

  const buckets: RevenueExpenseBucket[] = plan.map((b, i) => {
    const s = totals(results[i].data as SummaryRow[] | null);
    return { label: b.label, range: b.range, revenue_cents: s.revenue, expense_cents: s.expenses, cogs_cents: access.canCogs ? s.cogs : null };
  });
  const empty = buckets.every((b) => !b.revenue_cents && !b.expense_cents && !b.cogs_cents);

  return (
    <section className="rounded-2xl border border-border bg-surface p-4 sm:p-5 min-w-0">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 text-lg font-bold text-body">
          <ChartColumn className="h-5 w-5 text-muted" aria-hidden />
          Revenue vs Expenses
        </h2>
        <span className="rounded-lg border border-border bg-main px-2.5 py-1 text-xs text-muted">
          {plan[0]?.grain ?? 'Daily'} · {rangeLabel(range.from, range.to)}
        </span>
      </div>
      {failed?.error ? (
        <SectionError what="the chart" message={failed.error.message} />
      ) : empty ? (
        <EmptyState icon={ChartColumn} title="Nothing to chart yet" text={`No revenue or expenses were recorded in ${rangeLabel(range.from, range.to)}. Try a longer period.`} />
      ) : (
        <RevenueExpenseChart buckets={buckets} />
      )}
      {!failed && !empty && (
        <p className="mt-2 text-[11px] text-muted">
          Revenue is net sales; expenses are approved operating expenses dated in each period{access.canCogs ? ', stacked on food cost (COGS)' : ''}.
        </p>
      )}
    </section>
  );
}

function EmptyState({ icon: Icon, title, text }: { icon: LucideIcon; title: string; text: string }) {
  return (
    <div className="grid place-items-center rounded-xl border border-dashed border-border px-4 py-12 text-center">
      <Icon className="h-8 w-8 text-muted" aria-hidden />
      <p className="mt-2 text-sm font-semibold text-body">{title}</p>
      <p className="mt-1 max-w-sm text-xs text-muted">{text}</p>
    </div>
  );
}

// ── Recent transactions ────────────────────────────────────────────────────

type Kind = { label: string; direction: 'in' | 'out' | 'neutral'; icon: LucideIcon; accent: ModuleAccent };

/** What a ledger event means as a money movement. Info-only events (sign 0) never reach here. */
function kindOf(e: LedgerEvent): Kind {
  if (e.category === 'payment') {
    if (e.sign > 0) return { label: 'Customer payment', direction: 'in', icon: Banknote, accent: 'emerald' };
    if (e.event_type === 'REFUND_ISSUED') return { label: 'Refund', direction: 'out', icon: RotateCcw, accent: 'rose' };
    return { label: 'Payment reversed', direction: 'out', icon: RotateCcw, accent: 'rose' };
  }
  if (e.category === 'expense') {
    return e.sign > 0
      ? { label: 'Expense', direction: 'out', icon: Receipt, accent: 'rose' }
      : { label: 'Expense reversed', direction: 'in', icon: Receipt, accent: 'emerald' };
  }
  // payable: a bill adds to what is owed (no money moves yet); a payment pays it.
  if (e.event_type === 'SUPPLIER_PAYMENT_MADE') return { label: 'Supplier payment', direction: 'out', icon: Truck, accent: 'blue' };
  if (e.sign > 0) return { label: 'Supplier bill', direction: 'neutral', icon: FileText, accent: 'amber' };
  return { label: 'Supplier credit', direction: 'neutral', icon: FileText, accent: 'teal' };
}

const humanise = (s: string) => s.toLowerCase().replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);

function describe(e: LedgerEvent, supplier: string | null): string {
  const d = e.details ?? {};
  if (e.category === 'expense') return [str(d.category), str(d.description)].filter(Boolean).join(' – ') || humanise(e.event_type);
  if (e.category === 'payable') {
    const ref = str(d.invoice_number) ?? str(d.reference);
    return [supplier ?? 'Supplier', ref ? `#${ref}` : null].filter(Boolean).join(' · ');
  }
  // Customer payments: the method (cash / card …) and any reference.
  return [e.payment_method ? humanise(e.payment_method) : null, str(d.reference)].filter(Boolean).join(' · ') || humanise(e.event_type);
}

const RECENT = 6;

export async function RecentTransactions({
  client, range, access, viewAllHref,
}: { client: SupabaseClient; range: ResolvedFinancePeriod; access: Access; viewAllHref: string }) {
  const categories = ['payment', 'expense', ...(access.canPayables ? ['payable'] : [])];
  const results = await Promise.all(
    categories.map((c) => client.rpc('ledger_events', { p_from: range.from, p_to: range.to, p_category: c, p_limit: 20 })),
  );
  const failed = results.find((r) => r.error);
  const events = results
    .flatMap((r) => (r.data as LedgerEvent[] | null) ?? [])
    .filter((e) => e.sign !== 0)
    .sort((a, b) => (a.occurred_at < b.occurred_at ? 1 : a.occurred_at > b.occurred_at ? -1 : b.id - a.id))
    .slice(0, RECENT);

  // Supplier names, where this user may read suppliers (RLS); otherwise "Supplier".
  const supplierIds = [...new Set(events.map((e) => e.supplier_id).filter(Boolean))] as string[];
  const names = new Map<string, string>();
  if (supplierIds.length) {
    const { data } = await client.from('suppliers').select('id, name').in('id', supplierIds);
    for (const s of (data ?? []) as { id: string; name: string }[]) names.set(s.id, s.name);
  }

  return (
    <section className="flex min-w-0 flex-col rounded-2xl border border-border bg-surface p-4 sm:p-5">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 text-lg font-bold text-body">
          <Clock className="h-5 w-5 text-muted" aria-hidden />
          Recent Transactions
        </h2>
        <Link href={viewAllHref} className={`inline-flex items-center gap-1 rounded text-sm font-semibold text-body underline-offset-4 hover:underline ${FOCUS_RING}`}>
          View All<span className="sr-only"> transactions in the ledger</span>
        </Link>
      </div>
      {failed?.error ? (
        <SectionError what="recent transactions" message={failed.error.message} />
      ) : events.length === 0 ? (
        <EmptyState icon={Clock} title="No transactions" text={`No customer payments, expenses or supplier bills in ${rangeLabel(range.from, range.to)}.`} />
      ) : (
        <ul className="divide-y divide-border/70">
          {events.map((e) => {
            const k = kindOf(e);
            const Icon = k.icon;
            const amount = formatCents(Number(e.amount_cents));
            return (
              <li key={e.id} className="flex items-center gap-3 py-2.5">
                <span className={`grid h-9 w-9 shrink-0 place-items-center rounded-lg ${accentTile(k.accent)}`}>
                  <Icon className="h-4 w-4" aria-hidden />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-semibold text-body">{describe(e, e.supplier_id ? names.get(e.supplier_id) ?? null : null)}</span>
                  <span className="block text-[11px] text-muted">
                    {k.label} • {new Date(`${e.business_date}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })}
                  </span>
                </span>
                <span
                  className={`shrink-0 font-mono text-sm font-bold ${k.direction === 'in' ? 'text-ok' : k.direction === 'out' ? 'text-danger' : 'text-muted'}`}
                >
                  {k.direction === 'in' ? '+' : k.direction === 'out' ? '−' : ''}
                  {amount}
                  <span className="sr-only">{k.direction === 'in' ? ' in' : k.direction === 'out' ? ' out' : ' owed'}</span>
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
