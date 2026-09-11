import { notFound, redirect } from 'next/navigation';
import { createTenantServerClient } from '@/lib/supabase/tenant-server';
import { StatCard } from '@/components/StatCard';
import { Card } from '@/components/ui';
import { formatCents } from '@/lib/format';
import { ExpenseForm } from './ExpenseForm';

export const dynamic = 'force-dynamic';

type PeriodRow = {
  orders_count: number;
  gross_sales_cents: number;
  discount_cents: number;
  refunded_cents: number;
  net_sales_cents: number;
  avg_order_cents: number;
  theoretical_cogs_cents: number;
  cogs_lines_total: number;
  cogs_lines_missing: number;
  gross_profit_cents: number;
  gross_margin_pct: number | null;
  food_cost_pct: number | null;
  waste_cents: number;
  net_adjustment_cents: number;
  actual_cogs_cents: number;
  cogs_variance_cents: number;
  expenses_cents: number;
  net_profit_cents: number;
  net_profit_margin_pct: number | null;
};

type ItemRow = {
  menu_item_id: string;
  variant_id: string;
  name: string;
  qty_sold: number;
  revenue_cents: number;
  cogs_cents: number;
  cogs_known: boolean;
  contribution_cents: number;
  contribution_margin_pct: number | null;
  food_cost_pct: number | null;
};

type Expense = {
  id: string;
  category: string;
  description: string | null;
  amount_cents: number;
  expense_date: string;
};

export default async function FinancePage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const t = await createTenantServerClient(slug);
  if (!t) notFound();
  const {
    data: { user },
  } = await t.client.auth.getUser();
  if (!user) redirect(`/r/${slug}/login`);

  const since = new Date();
  since.setDate(since.getDate() - 30);
  const now = new Date();

  const [{ data: paid }, { data: periodRows, error: periodErr }, { data: itemRows }, { data: expenses }] =
    await Promise.all([
      t.client
        .from('orders')
        .select('total_cents, tax_cents, payment_method, paid_at')
        .not('paid_at', 'is', null)
        .gte('paid_at', since.toISOString()),
      t.client.rpc('period_profitability', { p_from: since.toISOString(), p_to: now.toISOString() }),
      t.client.rpc('item_profitability', { p_from: since.toISOString(), p_to: now.toISOString() }),
      t.client
        .from('expenses')
        .select('id, category, description, amount_cents, expense_date')
        .order('expense_date', { ascending: false })
        .limit(10),
    ]);

  const rows = paid ?? [];
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const sevenAgo = new Date();
  sevenAgo.setDate(sevenAgo.getDate() - 7);

  const sum = (list: typeof rows) => list.reduce((s, r) => s + (r.total_cents ?? 0), 0);
  const inRange = (from: Date) => rows.filter((r) => r.paid_at && new Date(r.paid_at) >= from);

  const today = inRange(startOfToday);
  const week = inRange(sevenAgo);
  const revenue30 = sum(rows);
  const tax30 = rows.reduce((s, r) => s + (r.tax_cents ?? 0), 0);
  const aov = rows.length ? Math.round(revenue30 / rows.length) : 0;

  const byMethod = rows.reduce<Record<string, { count: number; cents: number }>>((acc, r) => {
    const m = r.payment_method ?? 'unknown';
    acc[m] = acc[m] ?? { count: 0, cents: 0 };
    acc[m].count += 1;
    acc[m].cents += r.total_cents ?? 0;
    return acc;
  }, {});

  const p = ((periodRows as PeriodRow[] | null) ?? [])[0] ?? null;
  const items = ((itemRows as ItemRow[] | null) ?? [])
    .slice()
    .sort((a, b) => b.contribution_cents - a.contribution_cents)
    .slice(0, 8);
  const pct = (n: number | null) => (n == null ? '—' : `${n}%`);

  return (
    <div className="space-y-8 max-w-5xl">
      <h1 className="text-xl font-black">Finance</h1>
      <p className="text-muted text-xs -mt-6">Paid orders and profitability, last 30 days.</p>

      <section className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard label="Revenue today" value={formatCents(sum(today))} hint={`${today.length} orders`} />
        <StatCard label="Revenue 7d" value={formatCents(sum(week))} hint={`${week.length} orders`} />
        <StatCard label="Revenue 30d" value={formatCents(revenue30)} hint={`${rows.length} orders`} />
        <StatCard label="Avg order value" value={formatCents(aov)} />
      </section>

      {periodErr ? (
        <div className="rounded-lg border border-danger/40 bg-danger/10 text-danger p-4 text-xs">
          Couldn&apos;t load profitability: {periodErr.message}
        </div>
      ) : !p || p.orders_count === 0 ? (
        <Card>
          <p className="text-muted text-xs">No served/paid orders in the last 30 days yet — profitability will
            appear here once there are sales to measure.</p>
        </Card>
      ) : (
        <>
          <section>
            <h2 className="font-bold text-sm mb-3">Profitability (30d) — estimated, from recipe costs</h2>
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
              <StatCard label="Net sales" value={formatCents(p.net_sales_cents)} hint={`${p.orders_count} orders`} />
              <StatCard
                label="Theoretical food cost"
                value={pct(p.food_cost_pct)}
                hint={formatCents(p.theoretical_cogs_cents)}
                tone={p.cogs_lines_missing > 0 ? 'warn' : 'default'}
              />
              <StatCard
                label="Gross profit"
                value={formatCents(p.gross_profit_cents)}
                hint={`${pct(p.gross_margin_pct)} margin`}
                tone="ok"
              />
              <StatCard
                label="Net profit"
                value={formatCents(p.net_profit_cents)}
                hint={`after ${formatCents(p.expenses_cents)} expenses`}
                tone={p.net_profit_cents >= 0 ? 'ok' : 'danger'}
              />
            </div>
            {p.cogs_lines_missing > 0 && (
              <p className="text-warn text-[11px] mt-2">
                {p.cogs_lines_missing} of {p.cogs_lines_total} sold line(s) have no recipe configured — food cost
                and COGS above understate the true figure. Add recipes in Menu to complete this.
              </p>
            )}
            <p className="text-muted text-[11px] mt-2">
              Actual ingredient cost consumed/wasted/adjusted this period (read from the stock ledger):{' '}
              <span className="font-semibold text-body">{formatCents(p.actual_cogs_cents)}</span>
              {p.cogs_variance_cents !== 0 && (
                <>
                  {' '}
                  — {p.cogs_variance_cents > 0 ? 'above' : 'below'} the recipe-based theoretical figure by{' '}
                  <span className="font-semibold text-body">{formatCents(Math.abs(p.cogs_variance_cents))}</span>.{' '}
                  {p.waste_cents + Math.abs(p.net_adjustment_cents) >= Math.abs(p.cogs_variance_cents) * 0.8
                    ? `Recorded waste (${formatCents(p.waste_cents)}) and stock adjustments account for most of it.`
                    : 'Recorded waste/adjustments don’t fully explain the gap — some stock movements may predate cost tracking, or consumption timing crossed the period boundary. Worth reviewing rather than assumed as waste.'}
                </>
              )}
            </p>
          </section>

          <section>
            <h2 className="font-bold text-sm mb-3">Top items by contribution (30d)</h2>
            {items.length === 0 ? (
              <Card>
                <p className="text-muted text-xs">No à la carte sales in this window yet.</p>
              </Card>
            ) : (
              <Card className="p-0 overflow-hidden">
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-xs">
                    <thead className="text-muted border-b border-border">
                      <tr>
                        <th className="p-3 font-semibold">Item</th>
                        <th className="p-3 font-semibold text-right">Sold</th>
                        <th className="p-3 font-semibold text-right">Revenue</th>
                        <th className="p-3 font-semibold text-right">Food cost %</th>
                        <th className="p-3 font-semibold text-right">Contribution</th>
                        <th className="p-3 font-semibold text-right">Margin</th>
                      </tr>
                    </thead>
                    <tbody>
                      {items.map((it) => (
                        <tr key={`${it.menu_item_id}-${it.variant_id}`} className="border-b border-border/60 last:border-0">
                          <td className="p-3 font-semibold">
                            {it.name}
                            {!it.cogs_known && <span className="ml-2 text-warn text-[10px]">no recipe</span>}
                          </td>
                          <td className="p-3 text-right font-mono">{it.qty_sold}</td>
                          <td className="p-3 text-right font-mono">{formatCents(it.revenue_cents)}</td>
                          <td className="p-3 text-right text-muted">{pct(it.food_cost_pct)}</td>
                          <td className="p-3 text-right font-mono font-bold">{formatCents(it.contribution_cents)}</td>
                          <td className="p-3 text-right text-muted">{pct(it.contribution_margin_pct)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Card>
            )}
          </section>
        </>
      )}

      <section className="grid md:grid-cols-2 gap-6">
        <div className="rounded-lg border border-border bg-surface p-5">
          <h2 className="font-bold text-sm mb-3">Payment methods (30d)</h2>
          {Object.keys(byMethod).length === 0 ? (
            <p className="text-muted text-xs">No paid orders yet.</p>
          ) : (
            <table className="w-full text-left text-xs">
              <tbody>
                {Object.entries(byMethod).map(([m, v]) => (
                  <tr key={m} className="border-b border-border/60 last:border-0">
                    <td className="py-2 capitalize font-semibold">{m}</td>
                    <td className="py-2 text-muted">{v.count} orders</td>
                    <td className="py-2 text-right font-bold">{formatCents(v.cents)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div className="rounded-lg border border-border bg-surface p-5">
          <h2 className="font-bold text-sm mb-3">Summary (30d)</h2>
          <dl className="text-xs space-y-2">
            <div className="flex justify-between">
              <dt className="text-muted">Gross revenue</dt>
              <dd className="font-bold">{formatCents(revenue30)}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-muted">Tax collected</dt>
              <dd className="font-bold">{formatCents(tax30)}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-muted">Net of tax</dt>
              <dd className="font-bold">{formatCents(revenue30 - tax30)}</dd>
            </div>
          </dl>
          <p className="text-muted text-[11px] mt-3">
            Payroll/labor isn&apos;t tracked as a cost yet — Net profit above only deducts recorded expenses.
          </p>
        </div>
      </section>

      <section>
        <h2 className="font-bold text-sm mb-3">Expenses</h2>
        <ExpenseForm recent={(expenses as Expense[] | null) ?? []} />
      </section>
    </div>
  );
}
