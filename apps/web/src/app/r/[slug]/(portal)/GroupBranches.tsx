import Link from 'next/link';
import type { SupabaseClient } from '@supabase/supabase-js';
import { formatCents } from '@/lib/format';
import { todayIn } from '@/lib/financePeriod';

type Row = {
  branch_id: string; code: string; name: string; status: string; orders_count: number; net_sales_cents: number;
  cogs_cents: number; expenses_cents: number; open_low_stock: number; payables_outstanding_cents: number;
  last_closed_day: string | null; unclosed_days: number; cash_difference_cents: number;
};

/**
 * The group view on the dashboard (All branches): this month, branch by
 * branch, from branch_summary() — the same ledger the Finance pages use, so
 * the rows add up to the restaurant's totals. Shown only when there are
 * several branches and none is selected.
 */
export async function GroupBranches({ client, slug, timeZone }: { client: SupabaseClient; slug: string; timeZone: string }) {
  const today = todayIn(timeZone);
  const from = `${today.slice(0, 7)}-01`;
  const { data, error } = await client.rpc('branch_summary', { p_from: from, p_to: today });
  if (error) return null;
  const rows = (data ?? []) as Row[];
  if (rows.length < 2) return null;
  const net = (r: Row) => Number(r.net_sales_cents);
  const total = rows.reduce((n, r) => n + net(r), 0);
  return (
    <section className="rounded-lg border border-border bg-surface p-5 space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-bold">Your branches · this month</h2>
        <Link href={`/r/${slug}/finance/branches`} className="text-xs text-primary hover:underline">
          Compare branches →
        </Link>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {rows.map((r) => {
          const op = net(r) - Number(r.cogs_cents) - Number(r.expenses_cents);
          return (
            <div key={r.branch_id} className="rounded-lg border border-border p-3 space-y-1.5 text-xs">
              <p className="font-bold text-sm">
                {r.name} <span className="font-mono font-normal text-muted">{r.code}</span>
              </p>
              <p className="font-mono text-lg font-black">{formatCents(net(r))}</p>
              <div className="h-1.5 rounded bg-main">
                <div className="h-1.5 rounded bg-primary" style={{ width: `${total > 0 ? Math.round((net(r) / total) * 100) : 0}%` }} />
              </div>
              <p className="text-muted">
                {r.orders_count} orders · operating profit <span className={op < 0 ? 'text-danger' : 'text-body'}>{formatCents(op)}</span>
              </p>
              <p className="flex flex-wrap gap-x-3 text-muted">
                <span className={r.open_low_stock ? 'text-danger' : ''}>{r.open_low_stock} low stock</span>
                <span>{formatCents(Number(r.payables_outstanding_cents))} owed</span>
                <span className={r.unclosed_days ? 'text-warn' : ''}>
                  {r.unclosed_days ? `${r.unclosed_days} day(s) not closed` : r.last_closed_day ? `closed ${r.last_closed_day}` : 'no day closed yet'}
                </span>
                {Number(r.cash_difference_cents) !== 0 && <span className="text-danger">cash {formatCents(Number(r.cash_difference_cents))}</span>}
              </p>
            </div>
          );
        })}
      </div>
    </section>
  );
}
