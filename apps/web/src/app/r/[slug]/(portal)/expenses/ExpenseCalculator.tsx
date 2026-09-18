'use client';

import { useState } from 'react';
import { Card, Field, Input } from '@/components/ui';
import { formatCents } from '@/lib/format';

type ProfitRow = {
  net_sales_cents: number;
  gross_margin_pct: number | null;
  expenses_cents: number;
  net_profit_cents: number;
};

/**
 * What-if tool fed straight off this period's own period_profitability()
 * row — no separate calculation engine. "New expense" subtracts straight
 * from Net Profit and shows the extra sales (at this period's own gross
 * margin) needed to offset it; "Extra revenue" assumes it carries that
 * same average margin, since there's no way to know a hypothetical sale's
 * actual food cost ahead of time.
 */
export function ExpenseCalculator({ profit, periodLabel }: { profit: ProfitRow; periodLabel: string }) {
  const [mode, setMode] = useState<'expense' | 'revenue'>('expense');
  const [amount, setAmount] = useState('');

  const cents = Math.round((parseFloat(amount) || 0) * 100);
  const marginFrac = (profit.gross_margin_pct ?? 0) / 100;

  const projected =
    mode === 'expense'
      ? {
          newExpenses: profit.expenses_cents + cents,
          newNetProfit: profit.net_profit_cents - cents,
          newNetSales: profit.net_sales_cents,
          breakEvenSales: marginFrac > 0 ? Math.round(cents / marginFrac) : null,
        }
      : {
          newExpenses: profit.expenses_cents,
          newNetProfit: profit.net_profit_cents + Math.round(cents * marginFrac),
          newNetSales: profit.net_sales_cents + cents,
          breakEvenSales: null,
        };

  const newMarginPct =
    projected.newNetSales > 0 ? Math.round((projected.newNetProfit / projected.newNetSales) * 1000) / 10 : null;

  return (
    <Card>
      <h2 className="font-bold text-sm mb-1">Profit impact calculator</h2>
      <p className="text-muted text-[11px] mb-4">
        Model a hypothetical change against {periodLabel}&apos;s real numbers — nothing here is saved.
      </p>

      <div className="flex flex-wrap gap-4 items-end mb-4">
        <div className="flex rounded-lg border border-border overflow-hidden text-xs font-semibold">
          <button
            type="button"
            onClick={() => setMode('expense')}
            className={`px-3 py-2 ${mode === 'expense' ? 'bg-primary text-white' : 'bg-surface text-muted'}`}
          >
            New expense
          </button>
          <button
            type="button"
            onClick={() => setMode('revenue')}
            className={`px-3 py-2 ${mode === 'revenue' ? 'bg-primary text-white' : 'bg-surface text-muted'}`}
          >
            Extra revenue
          </button>
        </div>
        <Field label={mode === 'expense' ? 'Hypothetical expense amount' : 'Hypothetical extra sales'}>
          <Input
            type="number"
            min="0"
            step="0.01"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="0.00"
          />
        </Field>
      </div>

      {cents > 0 && (
        <div className="text-xs border border-border rounded-lg p-3 space-y-1.5">
          <div className="flex justify-between">
            <span className="text-muted">Projected Net Profit</span>
            <span className={`font-mono font-bold ${projected.newNetProfit >= 0 ? 'text-ok' : 'text-danger'}`}>
              {formatCents(projected.newNetProfit)}
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted">Projected Net Profit margin</span>
            <span className="font-mono">{newMarginPct != null ? `${newMarginPct}%` : '—'}</span>
          </div>
          <div className="flex justify-between text-muted">
            <span>vs. current Net Profit</span>
            <span className="font-mono">{formatCents(profit.net_profit_cents)}</span>
          </div>
          {mode === 'expense' && (
            <p className="text-muted pt-2 border-t border-border mt-1.5">
              {projected.breakEvenSales != null ? (
                <>
                  At this period&apos;s gross margin ({profit.gross_margin_pct ?? 0}%), you&apos;d need{' '}
                  <span className="font-semibold text-body">{formatCents(projected.breakEvenSales)}</span> in
                  additional sales to fully offset this expense.
                </>
              ) : (
                'No gross margin recorded this period, so a break-even sales figure can\'t be estimated.'
              )}
            </p>
          )}
          {mode === 'revenue' && (
            <p className="text-muted pt-2 border-t border-border mt-1.5">
              Assumes this sale carries the same {profit.gross_margin_pct ?? 0}% gross margin as the rest of{' '}
              {periodLabel} — an estimate, not a guarantee for any specific item.
            </p>
          )}
        </div>
      )}
    </Card>
  );
}
