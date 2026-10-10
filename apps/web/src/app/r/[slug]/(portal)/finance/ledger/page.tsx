import type { Metadata } from 'next';
import { Fragment } from 'react';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { createTenantServerClient } from '@/lib/supabase/tenant-server';
import { loadTenantCurrency } from '@/lib/currencyServer';
import { gatePortalPage, can } from '@/lib/permissions';
import { getTenantEntitlement } from '@/lib/entitlements';
import { PlanUpgradePaywall } from '@/components/PlanUpgradePaywall';
import { formatCents, formatDateTime } from '@/lib/format';
import { resolveFinancePeriod, monthLabel, rangeLabel } from '@/lib/financePeriod';
import { SectionReportButtons } from '@/components/SectionReportButtons';
import { FinancePeriodBar } from '@/components/FinancePeriodBar';
import { LedgerAdjustmentForm } from './LedgerAdjustmentForm';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Ledger' };

const CATEGORIES = ['revenue', 'cogs', 'payment', 'expense', 'payable', 'inventory', 'waste', 'cash', 'close', 'purchasing', 'adjustment'] as const;
const CATEGORY_LABEL: Record<string, string> = {
  revenue: 'Sales',
  cogs: 'Food cost',
  payment: 'Customer payments',
  expense: 'Expenses',
  payable: 'Supplier payables',
  inventory: 'Inventory value',
  waste: 'Waste',
  cash: 'Cash',
  close: 'Day close',
  purchasing: 'Purchasing',
  adjustment: 'Adjustments',
};
// Where each kind of source record is managed — the "open the record" link.
const SOURCE_PATH: Record<string, string> = {
  orders: 'orders',
  order_lines: 'orders',
  payments: 'checkout',
  expenses: 'expenses',
  supplier_invoices: 'purchasing',
  supplier_payments: 'purchasing',
  credit_notes: 'purchasing',
  purchase_orders: 'purchasing',
  cash_counts: 'close',
  cash_movements: 'close',
  daily_closings: 'close',
  stock_ledger: 'inventory',
};

type LedgerEvent = {
  id: number; event_type: string; category: string; sign: number; amount_cents: number; signed_cents: number;
  occurred_at: string; business_date: string; source_table: string; source_id: string | null; payment_method: string | null;
  actor_role: string | null; details: Record<string, unknown>;
};
type SummaryRow = { category: string; net_cents: number; increase_cents: number; decrease_cents: number; events: number };

const LIMIT = 1000;
const SORTS = [['newest', 'Newest first'], ['oldest', 'Oldest first'], ['largest', 'Largest amount'], ['smallest', 'Smallest amount']] as const;
type SortKey = (typeof SORTS)[number][0];

const humanise = (s: string) => s.toLowerCase().replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());

export default async function LedgerPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ period?: string; from?: string; to?: string; category?: string; sort?: string }>;
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
  const canAdjust = can(perms, role, 'finance.adjust_ledger');

  const { data: settings } = await t.client.from('business_settings').select('timezone').maybeSingle();
  // A link with from/to (e.g. from the Finance overview) is a custom range.
  const range = resolveFinancePeriod(sp, settings?.timezone ?? 'UTC');
  const sort = SORTS.some(([k]) => k === sp.sort) ? (sp.sort as SortKey) : 'newest';
  const category = CATEGORIES.includes(sp.category as (typeof CATEGORIES)[number]) ? (sp.category as string) : null;

  const [summaryRes, eventsRes] = await Promise.all([
    t.client.rpc('ledger_summary', { p_from: range.from, p_to: range.to }),
    t.client.rpc('ledger_events', { p_from: range.from, p_to: range.to, p_category: category, p_limit: LIMIT }),
  ]);
  const summary = (summaryRes.data as SummaryRow[] | null) ?? [];
  const events = ((eventsRes.data as LedgerEvent[] | null) ?? []).slice().sort((a, b) => {
    if (sort === 'largest') return Number(b.amount_cents) - Number(a.amount_cents);
    if (sort === 'smallest') return Number(a.amount_cents) - Number(b.amount_cents);
    const byTime = a.occurred_at < b.occurred_at ? -1 : a.occurred_at > b.occurred_at ? 1 : a.id - b.id;
    return sort === 'oldest' ? byTime : -byTime;
  });
  // Month headings (with the month's net) when sorted by date across more than one month.
  const byDate = sort === 'newest' || sort === 'oldest';
  const monthNet = new Map<string, number>();
  for (const e of events) monthNet.set(e.business_date.slice(0, 7), (monthNet.get(e.business_date.slice(0, 7)) ?? 0) + Number(e.signed_cents));
  const groupByMonth = byDate && monthNet.size > 1;
  const error = summaryRes.error?.message ?? eventsRes.error?.message;

  const base = `/r/${slug}`;
  const href = (q: Record<string, string | null>) => {
    const p = new URLSearchParams();
    const merged = { period: 'custom', from: range.from, to: range.to, category, sort: sort === 'newest' ? null : sort, ...q };
    for (const [k, v] of Object.entries(merged)) if (v) p.set(k, v);
    return `${base}/finance/ledger?${p.toString()}`;
  };

  return (
    <div className="space-y-5 max-w-6xl">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-xs">
            <Link href={`${base}/finance`} className="text-muted hover:underline">
              ← Finance
            </Link>
          </p>
          <h1 className="text-xl font-black">Ledger</h1>
          <p className="text-muted text-xs mt-1 max-w-2xl">
            Every money event — sales, food cost, payments, expenses, supplier bills, stock, cash — recorded automatically when it
            happens. Entries are never edited or deleted; mistakes are corrected with a new, reasoned adjustment.
          </p>
        </div>
        <SectionReportButtons
          slug={slug}
          restaurantName={t.config.restaurantName}
          domain="finance"
          label="Finance"
          range={{ from: range.from, to: range.to, label: rangeLabel(range.from, range.to) }}
        />
      </div>

      <FinancePeriodBar
        basePath={`${base}/finance/ledger`}
        period={range.period}
        from={range.from}
        to={range.to}
        keep={{ category, sort: sort === 'newest' ? null : sort }}
      />

      {error && <p className="rounded border border-danger/40 bg-danger/10 p-2 text-xs text-danger">Could not load the ledger: {error}</p>}

      <section className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 gap-2 text-xs">
        <Link
          href={href({ category: null })}
          className={`rounded-lg border p-2.5 ${category == null ? 'border-primary' : 'border-border'} bg-surface`}
        >
          <p className="text-muted">All categories</p>
          <p className="font-bold">{summary.reduce((s, r) => s + Number(r.events), 0)} entries</p>
        </Link>
        {summary.map((r) => (
          <Link
            key={r.category}
            href={href({ category: r.category })}
            className={`rounded-lg border p-2.5 ${category === r.category ? 'border-primary' : 'border-border'} bg-surface`}
          >
            <p className="text-muted">{CATEGORY_LABEL[r.category] ?? r.category}</p>
            <p className="font-bold font-mono">{formatCents(Number(r.net_cents))}</p>
            <p className="text-[10px] text-muted">
              +{formatCents(Number(r.increase_cents))} / −{formatCents(Number(r.decrease_cents))} · {Number(r.events)}
            </p>
          </Link>
        ))}
      </section>

      {canAdjust && <LedgerAdjustmentForm defaultDate={range.to} />}

      <section>
        <h2 className="font-bold text-sm mb-2">
          {category ? CATEGORY_LABEL[category] : 'All entries'} · {range.label}
          {events.length === LIMIT && <span className="text-muted font-normal"> (latest {LIMIT} shown — narrow the dates for more)</span>}
        </h2>
        <div className="flex flex-wrap items-center gap-1.5 mb-2 text-xs">
          <span className="text-muted">Sort:</span>
          {SORTS.map(([k, label]) => (
            <Link
              key={k}
              href={href({ sort: k === 'newest' ? null : k })}
              className={`rounded-full border px-2.5 py-0.5 ${sort === k ? 'border-primary bg-primary text-primary-fg' : 'border-border'}`}
            >
              {label}
            </Link>
          ))}
        </div>
        {events.length === 0 ? (
          <p className="text-xs text-muted">No ledger entries in this period.</p>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full text-left text-xs">
              <thead className="text-muted border-b border-border">
                <tr>
                  <th className="p-2 font-semibold">When</th>
                  <th className="p-2 font-semibold">Business day</th>
                  <th className="p-2 font-semibold">Event</th>
                  <th className="p-2 font-semibold">Category</th>
                  <th className="p-2 font-semibold text-right">Amount</th>
                  <th className="p-2 font-semibold">Source</th>
                </tr>
              </thead>
              <tbody>
                {events.map((e, i) => {
                  const path = SOURCE_PATH[e.source_table];
                  const reason = typeof e.details?.reason === 'string' ? (e.details.reason as string) : null;
                  const ym = e.business_date.slice(0, 7);
                  const newMonth = groupByMonth && (i === 0 || events[i - 1].business_date.slice(0, 7) !== ym);
                  return (
                    <Fragment key={e.id}>
                    {newMonth && (
                      <tr className="bg-main/60 border-b border-border">
                        <td colSpan={4} className="p-2 font-bold">{monthLabel(ym)}</td>
                        <td className="p-2 text-right font-mono font-bold">{formatCents(monthNet.get(ym) ?? 0)}</td>
                        <td className="p-2 text-muted">net for the month</td>
                      </tr>
                    )}
                    <tr className="border-b border-border/60 last:border-0 align-top">
                      <td className="p-2 whitespace-nowrap text-muted">{formatDateTime(e.occurred_at)}</td>
                      <td className="p-2 whitespace-nowrap font-mono">{e.business_date}</td>
                      <td className="p-2">
                        <span className="font-semibold">{humanise(e.event_type)}</span>
                        {e.payment_method && <span className="text-muted"> · {e.payment_method}</span>}
                        {reason && <p className="text-muted">“{reason}”</p>}
                      </td>
                      <td className="p-2">{CATEGORY_LABEL[e.category] ?? e.category}</td>
                      <td
                        className={`p-2 text-right font-mono whitespace-nowrap ${
                          e.sign > 0 ? '' : e.sign < 0 ? 'text-danger' : 'text-muted'
                        }`}
                      >
                        {e.sign === 0 ? formatCents(Number(e.amount_cents)) : `${e.sign < 0 ? '−' : '+'}${formatCents(Number(e.amount_cents))}`}
                      </td>
                      <td className="p-2 whitespace-nowrap">
                        {path ? (
                          <Link href={`${base}/${path}`} className="text-primary hover:underline">
                            {humanise(e.source_table)}
                            {e.source_id ? ` #${e.source_id.slice(0, 8)}` : ''}
                          </Link>
                        ) : (
                          <span className="text-muted">{humanise(e.source_table)}</span>
                        )}
                        {e.actor_role && <span className="text-muted"> · {e.actor_role}</span>}
                      </td>
                    </tr>
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <p className="mt-2 text-[11px] text-muted">
          Info-only entries (cash counts, day closes, purchase orders) carry no sign and do not change any balance.
        </p>
      </section>
    </div>
  );
}
