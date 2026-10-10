import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { createTenantServerClient } from '@/lib/supabase/tenant-server';
import { gatePortalPage, can } from '@/lib/permissions';
import { SectionReportButtons } from '@/components/SectionReportButtons';
import { PlanUpgradePaywall } from '@/components/PlanUpgradePaywall';
import { getTenantEntitlement } from '@/lib/entitlements';
import { ExpensesManager, type ExpenseSupplier } from './ExpensesManager';
import { EXPENSE_SELECT, type Expense } from './expenseShared';
import { FinancePeriodBar } from '@/components/FinancePeriodBar';
import { addDays, rangeLabel, resolveFinancePeriod, todayIn, zonedDayStart } from '@/lib/financePeriod';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Finance' };

type ProfitRow = {
  orders_count: number;
  gross_sales_cents: number;
  discount_cents: number;
  refunded_cents: number;
  net_sales_cents: number;
  theoretical_cogs_cents: number;
  gross_profit_cents: number;
  gross_margin_pct: number | null;
  expenses_cents: number;
  net_profit_cents: number;
  net_profit_margin_pct: number | null;
};

export default async function ExpensesPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ period?: string; from?: string; to?: string }>;
}) {
  const { slug } = await params;
  const sParams = await searchParams;
  const t = await createTenantServerClient(slug);
  if (!t) notFound();

  const { role, perms } = await gatePortalPage(t.client, slug, 'finance.view');

  const ent = await getTenantEntitlement(t.client, t.config.tier);
  if (!ent.isEntitled('accounting.finance')) {
    return <PlanUpgradePaywall slug={slug} featureKey="accounting.finance" currentTier={ent.tier} />;
  }

  const canWrite = can(perms, role, 'finance.create_expense') || can(perms, role, 'finance.update_expense');
  const canDelete = can(perms, role, 'finance.delete_expense');
  const canViewProfit = can(perms, role, 'finance.view_profit');
  const canApprove = can(perms, role, 'finance.approve_expense');
  const canPay = can(perms, role, 'finance.pay_expense');

  const { data: tzRow } = await t.client.from('business_settings').select('timezone').eq('id', true).maybeSingle();
  const tz = tzRow?.timezone ?? 'UTC';
  // Old links used ?period=1_month / 2_months.
  const legacy = sParams.period === '1_month' ? { period: '30d' } : sParams.period === '2_months' ? { period: 'custom', from: addDays(todayIn(tz), -59), to: todayIn(tz) } : sParams;
  const range = resolveFinancePeriod(legacy, tz, '30d');
  const fromStr = range.from;
  const toStr = range.to;
  // Day boundaries in the restaurant's own time zone.
  const fromDate = zonedDayStart(fromStr, tz);
  const toDate = new Date(zonedDayStart(addDays(toStr, 1), tz).getTime() - 1);
  const periodLabel = range.label === rangeLabel(fromStr, toStr) ? range.label : `${range.label} (${rangeLabel(fromStr, toStr)})`;

  const [
    { data: expenses, error },
    profitRes,
    dailySalesRes,
    { data: suppliers },
    { data: openRows },
  ] = await Promise.all([
    // Only expenses dated in the chosen period — the list, charts and PDF all follow it.
    t.client
      .from('expenses')
      .select(EXPENSE_SELECT)
      .gte('expense_date', fromStr)
      .lte('expense_date', toStr)
      .order('expense_date', { ascending: false })
      .order('created_at', { ascending: false })
      .limit(2000),
    canViewProfit
      ? t.client.rpc('period_profitability', { p_from: fromDate.toISOString(), p_to: toDate.toISOString() })
      : Promise.resolve({ data: null }),
    t.client.rpc('sales_by_day', { p_from: fromStr, p_to: toStr }),
    canWrite
      ? t.client.from('suppliers').select('id, name').eq('is_active', true).order('name')
      : Promise.resolve({ data: null }),
    // Waiting for approval / payment, whatever their date — the banner must not lose old ones.
    t.client.from('expenses').select('status, amount_cents').in('status', ['submitted', 'approved']).limit(5000),
  ]);
  const open = ((openRows ?? []) as { status: string; amount_cents: number }[]);
  const openSummary = {
    awaiting: open.filter((r) => r.status === 'submitted').length,
    awaitingCents: open.filter((r) => r.status === 'submitted').reduce((n, r) => n + Number(r.amount_cents), 0),
    unpaid: open.filter((r) => r.status === 'approved').length,
    unpaidCents: open.filter((r) => r.status === 'approved').reduce((n, r) => n + Number(r.amount_cents), 0),
  };

  const profit = ((profitRes.data as ProfitRow[] | null) ?? [])[0] ?? null;
  const dailySales = (dailySalesRes.data as Array<{ business_date: string; net_sales_cents: number; gross_sales_cents: number; discount_cents: number; refunded_cents: number; orders_count: number }> | null) ?? [];

  return (
    <div className="space-y-6 max-w-5xl">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-black">Finance & Profit Analytics</h1>
          <p className="text-muted text-xs mt-1">
            Track revenue, operating costs, gross margins, and net profit with live graphs, breakdown reports, and period sorting.
          </p>
        </div>
        <SectionReportButtons slug={slug} restaurantName={t.config.restaurantName} domain="expenses" label="Finance" />
      </div>
      {error ? (
        <div className="rounded-lg border border-danger/40 bg-danger/10 text-danger p-4 text-xs">{error.message}</div>
      ) : (
        <ExpensesManager
          slug={slug}
          restaurantName={t.config.restaurantName}
          expenses={(expenses as Expense[] | null) ?? []}
          profit={profit}
          dailySales={dailySales}
          periodBar={
            <FinancePeriodBar
              basePath={`/r/${slug}/expenses`}
              period={range.period}
              from={fromStr}
              to={toStr}
              compareLabel={`Showing ${rangeLabel(fromStr, toStr)}`}
            />
          }
          openSummary={openSummary}
          periodFromIso={fromDate.toISOString()}
          periodToIso={toDate.toISOString()}
          fromStr={fromStr}
          toStr={toStr}
          periodLabel={periodLabel}
          canWrite={canWrite}
          canDelete={canDelete}
          canViewProfit={canViewProfit}
          canApprove={canApprove}
          canPay={canPay}
          suppliers={(suppliers as ExpenseSupplier[] | null) ?? []}
        />
      )}
    </div>
  );
}
