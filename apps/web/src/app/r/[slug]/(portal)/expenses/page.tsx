import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { createTenantServerClient } from '@/lib/supabase/tenant-server';
import { gatePortalPage, can } from '@/lib/permissions';
import { SectionReportButtons } from '@/components/SectionReportButtons';
import { PlanUpgradePaywall } from '@/components/PlanUpgradePaywall';
import { getTenantEntitlement } from '@/lib/entitlements';
import { ExpensesManager, type ExpenseSupplier } from './ExpensesManager';
import { EXPENSE_SELECT, type Expense } from './expenseShared';

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

  const today = new Date();
  const formatYmd = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

  const activePeriod =
    sParams?.period === '2_months'
      ? '2_months'
      : sParams?.period === 'custom' && sParams?.from && sParams?.to
        ? 'custom'
        : '1_month';

  let fromDate: Date;
  let toDate: Date = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 23, 59, 59, 999);
  let fromStr: string;
  let toStr: string = formatYmd(today);
  let periodLabel = 'Last 30 Days (1 Month)';

  if (activePeriod === '2_months') {
    fromDate = new Date(today.getTime() - 60 * 86400_000);
    fromDate.setHours(0, 0, 0, 0);
    fromStr = formatYmd(fromDate);
    periodLabel = 'Last 60 Days (2 Months)';
  } else if (activePeriod === 'custom' && sParams.from && sParams.to) {
    fromStr = sParams.from;
    toStr = sParams.to;
    fromDate = new Date(`${sParams.from}T00:00:00`);
    toDate = new Date(`${sParams.to}T23:59:59`);
    periodLabel = `${sParams.from} to ${sParams.to}`;
  } else {
    // 1 Month (last 30 days)
    fromDate = new Date(today.getTime() - 30 * 86400_000);
    fromDate.setHours(0, 0, 0, 0);
    fromStr = formatYmd(fromDate);
    periodLabel = 'Last 30 Days (1 Month)';
  }

  const [
    { data: expenses, error },
    profitRes,
    dailySalesRes,
    { data: suppliers },
  ] = await Promise.all([
    t.client
      .from('expenses')
      .select(EXPENSE_SELECT)
      .order('expense_date', { ascending: false })
      .limit(500),
    canViewProfit
      ? t.client.rpc('period_profitability', { p_from: fromDate.toISOString(), p_to: toDate.toISOString() })
      : Promise.resolve({ data: null }),
    t.client.rpc('sales_by_day', { p_from: fromStr, p_to: toStr }),
    canWrite
      ? t.client.from('suppliers').select('id, name').eq('is_active', true).order('name')
      : Promise.resolve({ data: null }),
  ]);

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
          activePeriod={activePeriod}
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
