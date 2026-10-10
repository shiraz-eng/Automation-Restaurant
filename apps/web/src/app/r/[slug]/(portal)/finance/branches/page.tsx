import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { createTenantServerClient } from '@/lib/supabase/tenant-server';
import { loadTenantCurrency } from '@/lib/currencyServer';
import { gatePortalPage, can } from '@/lib/permissions';
import { formatCents } from '@/lib/format';
import { resolveFinancePeriod, rangeLabel } from '@/lib/financePeriod';
import { FinancePeriodBar } from '@/components/FinancePeriodBar';
import { loadBranchContext } from '@/lib/branchServer';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Branch comparison' };

type Row = {
  branch_id: string; code: string; name: string; status: string; is_default: boolean;
  orders_count: number; net_sales_cents: number; cogs_cents: number; expenses_cents: number; payments_cents: number;
  open_low_stock: number; payables_outstanding_cents: number; last_closed_day: string | null; unclosed_days: number;
  cash_difference_cents: number;
};
type SummaryRow = { category: string; net_cents: number };

export default async function BranchComparisonPage({
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
  await loadTenantCurrency(t.client);
  const { role, perms } = await gatePortalPage(t.client, slug, 'finance.view');
  const canCogs = can(perms, role, 'finance.view_cogs') || can(perms, role, 'finance.view_profit');

  const { data: settings } = await t.client.from('business_settings').select('timezone').maybeSingle();
  const range = resolveFinancePeriod(sp, settings?.timezone ?? 'UTC');
  const [summaryRes, consolidatedRes, ctx] = await Promise.all([
    t.client.rpc('branch_summary', { p_from: range.from, p_to: range.to }),
    t.client.rpc('ledger_summary', { p_from: range.from, p_to: range.to }),
    loadBranchContext(t.client),
  ]);
  const rows = ((summaryRes.data ?? []) as Row[]).map((r) => ({
    ...r,
    net: Number(r.net_sales_cents),
    cogs: Number(r.cogs_cents),
    exp: Number(r.expenses_cents),
  }));
  const total = rows.reduce(
    (a, r) => ({
      orders: a.orders + r.orders_count, net: a.net + r.net, cogs: a.cogs + r.cogs, exp: a.exp + r.exp,
      pay: a.pay + Number(r.payments_cents), low: a.low + r.open_low_stock, owed: a.owed + Number(r.payables_outstanding_cents),
      unclosed: a.unclosed + r.unclosed_days, diff: a.diff + Number(r.cash_difference_cents),
    }),
    { orders: 0, net: 0, cogs: 0, exp: 0, pay: 0, low: 0, owed: 0, unclosed: 0, diff: 0 },
  );
  // Ledger lines that belong to no branch (supplier payments, credit notes, manual corrections).
  const consolidated = (consolidatedRes.data ?? []) as SummaryRow[];
  const orgWide = (cat: string, branchTotal: number) => Number(consolidated.find((c) => c.category === cat)?.net_cents ?? 0) - branchTotal;
  const orgRevenue = ctx.selectedId ? 0 : orgWide('revenue', total.net);
  const orgCogs = ctx.selectedId ? 0 : orgWide('cogs', total.cogs);
  const orgExp = ctx.selectedId ? 0 : orgWide('expense', total.exp);
  const pct = (a: number, b: number) => (b > 0 ? `${Math.round((a / b) * 1000) / 10}%` : '—');
  const maxNet = Math.max(1, ...rows.map((r) => r.net));

  return (
    <div className="space-y-5 max-w-6xl">
      <div>
        <p className="text-xs">
          <Link href={`/r/${slug}/finance`} className="text-muted hover:underline">
            ← Finance
          </Link>
        </p>
        <h1 className="text-xl font-black">Branch comparison</h1>
        <p className="text-muted text-xs mt-1 max-w-2xl">
          Every branch side by side for {rangeLabel(range.from, range.to)}, from the same ledger as the Finance overview. Each sale,
          cost and expense belongs to exactly one branch, so the rows add up to the group total.
          {ctx.selectedId && ' You are working in one branch — choose All branches in the menu to compare them all.'}
        </p>
      </div>

      <FinancePeriodBar basePath={`/r/${slug}/finance/branches`} period={range.period} from={range.from} to={range.to} />

      {summaryRes.error ? (
        <div className="rounded-lg border border-border bg-surface p-4 text-xs text-muted">
          Branch reporting is waiting for this restaurant&apos;s multi-branch database update.
        </div>
      ) : (
        <>
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full text-left text-xs">
              <thead className="text-muted border-b border-border">
                <tr>
                  <th className="p-2.5 font-semibold">Branch</th>
                  <th className="p-2.5 font-semibold text-right">Orders</th>
                  <th className="p-2.5 font-semibold text-right">Net sales</th>
                  <th className="p-2.5 font-semibold text-right">Avg order</th>
                  {canCogs && <th className="p-2.5 font-semibold text-right">Food cost</th>}
                  {canCogs && <th className="p-2.5 font-semibold text-right">Gross profit</th>}
                  <th className="p-2.5 font-semibold text-right">Expenses</th>
                  {canCogs && <th className="p-2.5 font-semibold text-right">Operating profit</th>}
                  <th className="p-2.5 font-semibold text-right">Owed to suppliers</th>
                  <th className="p-2.5 font-semibold text-right">Low stock</th>
                  <th className="p-2.5 font-semibold">Day close</th>
                  <th className="p-2.5 font-semibold text-right">Cash difference</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.branch_id} className="border-b border-border/60 last:border-0 align-top">
                    <td className="p-2.5">
                      <p className="font-semibold">
                        {r.name} <span className="font-mono text-muted">{r.code}</span>
                      </p>
                      <div className="mt-1 h-1.5 w-32 rounded bg-main">
                        <div className="h-1.5 rounded bg-primary" style={{ width: `${Math.round((r.net / maxNet) * 100)}%` }} />
                      </div>
                      {r.status !== 'active' && <p className="text-warn">{r.status}</p>}
                    </td>
                    <td className="p-2.5 text-right font-mono">{r.orders_count}</td>
                    <td className="p-2.5 text-right font-mono font-bold">{formatCents(r.net)}</td>
                    <td className="p-2.5 text-right font-mono">{r.orders_count ? formatCents(Math.round(r.net / r.orders_count)) : '—'}</td>
                    {canCogs && (
                      <td className="p-2.5 text-right font-mono">
                        {formatCents(r.cogs)} <span className="text-muted">{pct(r.cogs, r.net)}</span>
                      </td>
                    )}
                    {canCogs && <td className="p-2.5 text-right font-mono">{formatCents(r.net - r.cogs)}</td>}
                    <td className="p-2.5 text-right font-mono">{formatCents(r.exp)}</td>
                    {canCogs && (
                      <td className={`p-2.5 text-right font-mono font-bold ${r.net - r.cogs - r.exp < 0 ? 'text-danger' : ''}`}>{formatCents(r.net - r.cogs - r.exp)}</td>
                    )}
                    <td className="p-2.5 text-right font-mono">{formatCents(Number(r.payables_outstanding_cents))}</td>
                    <td className={`p-2.5 text-right font-mono ${r.open_low_stock ? 'text-danger' : 'text-muted'}`}>{r.open_low_stock}</td>
                    <td className="p-2.5">
                      {r.last_closed_day ? `closed ${r.last_closed_day}` : 'never closed'}
                      {r.unclosed_days > 0 && <p className="text-warn">{r.unclosed_days} day(s) with sales not closed</p>}
                    </td>
                    <td className={`p-2.5 text-right font-mono ${Number(r.cash_difference_cents) ? 'text-danger' : 'text-muted'}`}>
                      {formatCents(Number(r.cash_difference_cents))}
                    </td>
                  </tr>
                ))}
              </tbody>
              {rows.length > 1 && (
                <tfoot className="border-t border-border bg-main/60 font-bold">
                  <tr>
                    <td className="p-2.5">All branches</td>
                    <td className="p-2.5 text-right font-mono">{total.orders}</td>
                    <td className="p-2.5 text-right font-mono">{formatCents(total.net)}</td>
                    <td className="p-2.5 text-right font-mono">{total.orders ? formatCents(Math.round(total.net / total.orders)) : '—'}</td>
                    {canCogs && <td className="p-2.5 text-right font-mono">{formatCents(total.cogs)} <span className="text-muted">{pct(total.cogs, total.net)}</span></td>}
                    {canCogs && <td className="p-2.5 text-right font-mono">{formatCents(total.net - total.cogs)}</td>}
                    <td className="p-2.5 text-right font-mono">{formatCents(total.exp)}</td>
                    {canCogs && <td className="p-2.5 text-right font-mono">{formatCents(total.net - total.cogs - total.exp)}</td>}
                    <td className="p-2.5 text-right font-mono">{formatCents(total.owed)}</td>
                    <td className="p-2.5 text-right font-mono">{total.low}</td>
                    <td className="p-2.5">{total.unclosed > 0 ? `${total.unclosed} unclosed day(s)` : 'all closed'}</td>
                    <td className="p-2.5 text-right font-mono">{formatCents(total.diff)}</td>
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
          {(orgRevenue !== 0 || orgCogs !== 0 || orgExp !== 0) && (
            <p className="text-xs text-muted">
              Organization-wide ledger corrections not tied to a branch: sales {formatCents(orgRevenue)}, food cost {formatCents(orgCogs)},
              expenses {formatCents(orgExp)}. They are in the consolidated Finance overview, not in any branch row.
            </p>
          )}
          <p className="text-[11px] text-muted">
            Supplier payments are made by the organization; what each branch still owes comes from its own approved invoices.
          </p>
        </>
      )}
    </div>
  );
}
