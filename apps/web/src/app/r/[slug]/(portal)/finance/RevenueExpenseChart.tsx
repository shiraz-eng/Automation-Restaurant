'use client';

import { useMemo } from 'react';
import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, type TooltipProps } from 'recharts';
import { axisMoney, formatCents } from '@/lib/format';

export type RevenueExpenseBucket = {
  /** Short axis label, e.g. "5 Oct" or "Oct 2026". */
  label: string;
  /** Full label for the tooltip, e.g. "5 Oct – 11 Oct 2026". */
  range: string;
  revenue_cents: number;
  expense_cents: number;
  /** null when the viewer may not see food cost. */
  cogs_cents: number | null;
};

// Series colours: literal values, because SVG fill attributes can't read CSS
// variables. Mid-tone violet / amber / rose read on light and dark surfaces.
const REVENUE = '#8b5cf6';
const COGS = '#f59e0b';
const EXPENSE = '#f43f5e';

function ChartTooltip({ active, payload }: TooltipProps<number, string>) {
  if (!active || !payload?.[0]) return null;
  const b = payload[0].payload as RevenueExpenseBucket;
  return (
    <div className="rounded-lg border border-border bg-surface px-3 py-2 text-[0.6875rem] shadow-lg space-y-0.5">
      <p className="font-bold text-body mb-1">{b.range}</p>
      <Row color={REVENUE} label="Revenue" cents={b.revenue_cents} />
      {b.cogs_cents != null && <Row color={COGS} label="Food cost" cents={b.cogs_cents} />}
      <Row color={EXPENSE} label="Expenses" cents={b.expense_cents} />
      {b.cogs_cents != null && (
        <p className="border-t border-border pt-1 mt-1 text-muted">
          Operating profit{' '}
          <span className="font-mono font-bold text-body">{formatCents(b.revenue_cents - b.cogs_cents - b.expense_cents)}</span>
        </p>
      )}
    </div>
  );
}

function Row({ color, label, cents }: { color: string; label: string; cents: number }) {
  return (
    <p className="flex items-center gap-1.5 text-muted">
      <span className="h-2 w-2 rounded-full" style={{ background: color }} aria-hidden />
      {label} <span className="ms-auto ps-3 font-mono text-body">{formatCents(cents)}</span>
    </p>
  );
}

/**
 * Revenue next to costs for each day / week / month of the chosen period.
 * Costs stack food cost (when the viewer may see it) under operating
 * expenses, so the gap between the two bars is the operating profit — the
 * same definition the KPI cards and Finance overview use.
 */
export function RevenueExpenseChart({ buckets }: { buckets: RevenueExpenseBucket[] }) {
  const showCogs = buckets.some((b) => b.cogs_cents != null);
  const data = useMemo(
    () =>
      buckets.map((b) => ({
        ...b,
        revenue: b.revenue_cents / 100,
        cogs: (b.cogs_cents ?? 0) / 100,
        expense: b.expense_cents / 100,
      })),
    [buckets],
  );
  const summary = `${buckets.length} periods. Total revenue ${formatCents(buckets.reduce((s, b) => s + b.revenue_cents, 0))}, total expenses ${formatCents(
    buckets.reduce((s, b) => s + b.expense_cents, 0),
  )}${showCogs ? `, total food cost ${formatCents(buckets.reduce((s, b) => s + (b.cogs_cents ?? 0), 0))}` : ''}.`;

  return (
    <div>
      <ul className="mb-3 flex flex-wrap items-center gap-x-5 gap-y-1 text-xs text-muted" aria-label="Legend">
        <Legend color={REVENUE} label="Revenue" />
        {showCogs && <Legend color={COGS} label="Food cost" />}
        <Legend color={EXPENSE} label="Expenses" />
      </ul>
      <div className="h-64 sm:h-72" role="img" aria-label={`Revenue versus expenses chart. ${summary}`}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} margin={{ top: 4, right: 4, left: 0, bottom: 0 }} barGap={2} barCategoryGap={buckets.length > 20 ? '18%' : '28%'}>
            <CartesianGrid strokeDasharray="3 3" stroke="rgb(var(--border-color))" vertical={false} />
            <XAxis
              dataKey="label"
              tick={{ fontSize: 11, fill: 'rgb(var(--text-muted))' }}
              tickLine={false}
              axisLine={{ stroke: 'rgb(var(--border-color))' }}
              interval="preserveStartEnd"
              minTickGap={18}
            />
            <YAxis
              tick={{ fontSize: 11, fill: 'rgb(var(--text-muted))' }}
              tickFormatter={(v: number) => axisMoney(v)}
              tickLine={false}
              axisLine={false}
              width={64}
            />
            <Tooltip content={<ChartTooltip />} cursor={{ fill: 'rgb(var(--border-color) / 0.35)' }} />
            <Bar dataKey="revenue" name="Revenue" fill={REVENUE} radius={[4, 4, 0, 0]} maxBarSize={22} />
            {showCogs && <Bar dataKey="cogs" name="Food cost" stackId="costs" fill={COGS} maxBarSize={22} />}
            <Bar dataKey="expense" name="Expenses" stackId="costs" fill={EXPENSE} radius={[4, 4, 0, 0]} maxBarSize={22} />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

function Legend({ color, label }: { color: string; label: string }) {
  return (
    <li className="flex items-center gap-1.5">
      <span className="h-2.5 w-2.5 rounded-full" style={{ background: color }} aria-hidden />
      {label}
    </li>
  );
}
