'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { PERIOD_LABELS, isWholeMonth, monthEnd, shiftMonth, type FinancePeriod } from '@/lib/financePeriod';

/**
 * The date picker every Finance screen shares (Finance overview, Ledger,
 * Expenses): quick periods, any month (with ‹ › to step month by month) and
 * a custom from/to range. Everything lives in the URL (?period=… or
 * ?period=custom&from=…&to=…), so a view can be bookmarked or shared.
 */
export function FinancePeriodBar({
  basePath,
  period,
  from,
  to,
  compareLabel,
  keep = {},
  presets = ['today', 'yesterday', '7d', 'month', 'last_month', '30d', 'this_year'],
}: {
  basePath: string;
  period: FinancePeriod;
  from: string;
  to: string;
  /** e.g. "vs 1 Sep – 10 Sep 2026" */
  compareLabel?: string;
  /** Other query params to carry over (e.g. a ledger category). */
  keep?: Record<string, string | null | undefined>;
  presets?: Exclude<FinancePeriod, 'custom'>[];
}) {
  const router = useRouter();
  const [customFrom, setCustomFrom] = useState(from);
  const [customTo, setCustomTo] = useState(to);
  const wholeMonth = period !== 'today' && period !== 'yesterday' && isWholeMonth(from, to);
  const pickedMonth = wholeMonth || period === 'month' ? from.slice(0, 7) : '';

  const href = (q: Record<string, string>) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries({ ...keep, ...q })) if (v) p.set(k, v);
    return `${basePath}?${p.toString()}`;
  };
  const monthHref = (ym: string) => href({ period: 'custom', from: `${ym}-01`, to: monthEnd(`${ym}-01`) });

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-xs">
      <nav className="flex flex-wrap gap-1.5" aria-label="Period">
        {presets.map((p) => (
          <Link
            key={p}
            href={href({ period: p })}
            className={`rounded-full border px-3 py-1 ${period === p ? 'border-primary bg-primary text-primary-fg' : 'border-border hover:border-primary/60'}`}
          >
            {PERIOD_LABELS[p]}
          </Link>
        ))}
      </nav>

      <div className="flex items-center gap-1" aria-label="Pick a month">
        {pickedMonth && (
          <Link href={monthHref(shiftMonth(pickedMonth, -1))} className="rounded border border-border px-2 py-1" aria-label="Previous month">
            ‹
          </Link>
        )}
        <input
          id="finance-month"
          type="month"
          value={pickedMonth}
          onChange={(e) => e.target.value && router.push(monthHref(e.target.value))}
          className="rounded border border-border bg-surface px-2 py-1"
          aria-label="Month"
        />
        {pickedMonth && (
          <Link href={monthHref(shiftMonth(pickedMonth, 1))} className="rounded border border-border px-2 py-1" aria-label="Next month">
            ›
          </Link>
        )}
      </div>

      <form
        className="flex flex-wrap items-center gap-1"
        onSubmit={(e) => {
          e.preventDefault();
          if (customFrom && customTo && customFrom <= customTo) router.push(href({ period: 'custom', from: customFrom, to: customTo }));
        }}
      >
        <input id="finance-from" type="date" value={customFrom} onChange={(e) => setCustomFrom(e.target.value)} className="rounded border border-border bg-surface px-2 py-1" aria-label="From" />
        <span className="text-muted">to</span>
        <input id="finance-to" type="date" value={customTo} onChange={(e) => setCustomTo(e.target.value)} className="rounded border border-border bg-surface px-2 py-1" aria-label="To" />
        <button type="submit" className="rounded border border-border px-2.5 py-1 font-semibold hover:border-primary/60">
          Apply
        </button>
      </form>

      {compareLabel && <span className="text-muted">{compareLabel}</span>}
    </div>
  );
}
