import { notFound } from 'next/navigation';
import { createTenantServerClient } from '@/lib/supabase/tenant-server';
import { gatePortalPage, can } from '@/lib/permissions';
import { SectionReportButtons } from '@/components/SectionReportButtons';
import { ExpensesManager, type Expense, type ExpenseSupplier } from './ExpensesManager';

export const dynamic = 'force-dynamic';

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

export default async function ExpensesPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const t = await createTenantServerClient(slug);
  if (!t) notFound();

  const { role, perms } = await gatePortalPage(t.client, slug, 'finance.view');
  const canWrite = can(perms, role, 'finance.create_expense') || can(perms, role, 'finance.update_expense');
  const canDelete = can(perms, role, 'finance.delete_expense');
  const canViewProfit = can(perms, role, 'finance.view_profit');

  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

  const [{ data: expenses, error }, profitRes, { data: suppliers }] = await Promise.all([
    t.client
      .from('expenses')
      .select('id, category, description, amount_cents, expense_date, supplier_id')
      .order('expense_date', { ascending: false })
      .limit(200),
    canViewProfit
      ? t.client.rpc('period_profitability', { p_from: monthStart.toISOString(), p_to: now.toISOString() })
      : Promise.resolve({ data: null }),
    canWrite
      ? t.client.from('suppliers').select('id, name').eq('is_active', true).order('name')
      : Promise.resolve({ data: null }),
  ]);

  const profit = ((profitRes.data as ProfitRow[] | null) ?? [])[0] ?? null;

  return (
    <div className="space-y-6 max-w-5xl">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-black">Expenses</h1>
          <p className="text-muted text-xs mt-1">
            Track operating costs and see their real impact on Net Profit — the same figures the Dashboard reports
            from.
          </p>
        </div>
        <SectionReportButtons slug={slug} restaurantName={t.config.restaurantName} domain="expenses" label="Expenses" />
      </div>
      {error ? (
        <div className="rounded-lg border border-danger/40 bg-danger/10 text-danger p-4 text-xs">{error.message}</div>
      ) : (
        <ExpensesManager
          expenses={(expenses as Expense[] | null) ?? []}
          profit={profit}
          periodFromIso={monthStart.toISOString()}
          periodToIso={now.toISOString()}
          periodLabel="this month"
          canWrite={canWrite}
          canDelete={canDelete}
          canViewProfit={canViewProfit}
          suppliers={(suppliers as ExpenseSupplier[] | null) ?? []}
        />
      )}
    </div>
  );
}
