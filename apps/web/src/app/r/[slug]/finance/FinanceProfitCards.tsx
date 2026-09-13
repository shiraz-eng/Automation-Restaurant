'use client';

import { useState } from 'react';
import { StatCard } from '@/components/StatCard';
import { ProfitDrilldownModal } from '@/components/ProfitDrilldown';
import { formatCents } from '@/lib/format';

type ProfitRow = {
  orders_count: number;
  gross_sales_cents: number;
  discount_cents: number;
  refunded_cents: number;
  net_sales_cents: number;
  theoretical_cogs_cents: number;
  gross_profit_cents: number;
  gross_margin_pct: number | null;
  food_cost_pct: number | null;
  cogs_lines_missing: number;
  expenses_cents: number;
  net_profit_cents: number;
  net_profit_margin_pct: number | null;
};

const pct = (n: number | null) => (n == null ? '—' : `${n}%`);

/**
 * The four profitability StatCards on /finance, made interactive: Gross
 * profit and Net profit open the same drill-down modal the Dashboard
 * uses (spec §8-10, §28) — same component, same RPCs, just fed this
 * page's own 30-day window instead of the Dashboard's named period. A
 * client island inside an otherwise server-rendered page, so the initial
 * page load stays a single server round-trip; only opening the
 * drill-down does any extra client-side fetching.
 */
export function FinanceProfitCards({ profit, fromIso, toIso, periodLabel }: { profit: ProfitRow; fromIso: string; toIso: string; periodLabel: string }) {
  const [drilldownLevel, setDrilldownLevel] = useState<'net_profit' | 'gross_profit' | null>(null);

  return (
    <>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard label="Net sales" value={formatCents(profit.net_sales_cents)} hint={`${profit.orders_count} orders`} />
        <StatCard
          label="Theoretical food cost"
          value={pct(profit.food_cost_pct)}
          hint={formatCents(profit.theoretical_cogs_cents)}
          tone={profit.cogs_lines_missing > 0 ? 'warn' : 'default'}
        />
        <button onClick={() => setDrilldownLevel('gross_profit')} className="text-left rounded-lg hover:ring-2 hover:ring-primary/40 transition-shadow">
          <StatCard label="Gross profit ↴" value={formatCents(profit.gross_profit_cents)} hint={`${pct(profit.gross_margin_pct)} margin`} tone="ok" />
        </button>
        <button onClick={() => setDrilldownLevel('net_profit')} className="text-left rounded-lg hover:ring-2 hover:ring-primary/40 transition-shadow">
          <StatCard
            label="Net profit ↴"
            value={formatCents(profit.net_profit_cents)}
            hint={`after ${formatCents(profit.expenses_cents)} expenses`}
            tone={profit.net_profit_cents >= 0 ? 'ok' : 'danger'}
          />
        </button>
      </div>

      {drilldownLevel && (
        <ProfitDrilldownModal
          profit={profit}
          from={new Date(fromIso)}
          to={new Date(toIso)}
          periodLabel={periodLabel}
          initialLevel={drilldownLevel}
          onClose={() => setDrilldownLevel(null)}
        />
      )}
    </>
  );
}
