'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { usePortalSupabase } from '@/components/PortalProvider';
import { Button, Card, Field, Input, Select } from '@/components/ui';
import { formatCents } from '@/lib/format';
import { ProfitDrilldownModal } from '@/components/ProfitDrilldown';

type Expense = {
  id: string;
  category: string;
  description: string | null;
  amount_cents: number;
  expense_date: string;
};

type ProfitRow = {
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

const CATEGORIES = ['Rent', 'Utilities', 'Labor', 'Marketing', 'Maintenance', 'Supplies', 'Other'];

/**
 * Manual entry point for operating expenses (spec §9, §16, §28-29) — the
 * authoritative backend stays in control: this writes straight to
 * public.expenses (RLS-gated on finance.create_expense/delete_expense), the
 * same table period_profitability() reads to reach real Net Profit. No AI
 * write path exists for this — expenses are deliberately manual-only.
 *
 * `profit`/`fromIso`/`toIso` are optional — if the caller couldn't see
 * profitability (no finance.view_profit etc.), this still renders the
 * plain add-expense form and recent-records table, just without the
 * "view by category" drill-down entry point.
 */
export function ExpenseForm({
  recent,
  profit,
  fromIso,
  toIso,
  periodLabel,
}: {
  recent: Expense[];
  profit?: ProfitRow;
  fromIso?: string;
  toIso?: string;
  periodLabel?: string;
}) {
  const router = useRouter();
  const supabase = usePortalSupabase();
  const [category, setCategory] = useState(CATEGORIES[0]);
  const [description, setDescription] = useState('');
  const [amount, setAmount] = useState('');
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [busy, setBusy] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [drilldownOpen, setDrilldownOpen] = useState(false);

  async function addExpense(e: React.FormEvent) {
    e.preventDefault();
    const cents = Math.round(parseFloat(amount) * 100);
    if (!Number.isFinite(cents) || cents <= 0) {
      setError('Enter a valid amount.');
      return;
    }
    setBusy(true);
    setError(null);
    const { error } = await supabase.from('expenses').insert({
      category,
      description: description.trim() || null,
      amount_cents: cents,
      expense_date: date,
    });
    setBusy(false);
    if (error) {
      setError(error.message);
      return;
    }
    setDescription('');
    setAmount('');
    router.refresh();
  }

  async function remove(id: string) {
    if (!window.confirm('Delete this expense?')) return;
    setBusyId(id);
    setError(null);
    const { error } = await supabase.from('expenses').delete().eq('id', id);
    setBusyId(null);
    if (error) {
      setError(error.message);
      return;
    }
    router.refresh();
  }

  return (
    <div className="space-y-4">
      {error && (
        <div className="rounded border border-danger/40 bg-danger/10 text-danger p-3 text-xs">{error}</div>
      )}
      <Card>
        <form onSubmit={addExpense} className="grid grid-cols-1 sm:grid-cols-5 gap-3 items-end">
          <Field label="Category">
            <Select value={category} onChange={(e) => setCategory(e.target.value)}>
              {CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Description">
            <Input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="optional" />
          </Field>
          <Field label="Amount">
            <Input type="number" min="0.01" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} />
          </Field>
          <Field label="Date">
            <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </Field>
          <Button type="submit" disabled={busy}>
            Add expense
          </Button>
        </form>
      </Card>

      {profit && fromIso && toIso && (
        <div className="flex items-center justify-between text-xs">
          <span className="text-muted">
            Total for {periodLabel ?? 'this period'}: <span className="font-bold text-body">{formatCents(profit.expenses_cents)}</span>
          </span>
          <button onClick={() => setDrilldownOpen(true)} className="text-primary font-semibold underline underline-offset-2">
            View by category →
          </button>
        </div>
      )}

      <Card className="p-0 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="text-muted border-b border-border">
              <tr>
                <th className="p-3 font-semibold">Date</th>
                <th className="p-3 font-semibold">Category</th>
                <th className="p-3 font-semibold">Description</th>
                <th className="p-3 font-semibold text-right">Amount</th>
                <th className="p-3"></th>
              </tr>
            </thead>
            <tbody>
              {recent.length === 0 ? (
                <tr>
                  <td colSpan={5} className="p-3 text-muted">
                    No expenses recorded yet.
                  </td>
                </tr>
              ) : (
                recent.map((ex) => (
                  <tr key={ex.id} className="border-b border-border/60 last:border-0">
                    <td className="p-3 text-muted">{ex.expense_date}</td>
                    <td className="p-3 font-semibold">{ex.category}</td>
                    <td className="p-3 text-muted">{ex.description ?? '—'}</td>
                    <td className="p-3 text-right font-mono">{formatCents(ex.amount_cents)}</td>
                    <td className="p-3 text-right">
                      <button
                        onClick={() => remove(ex.id)}
                        disabled={busyId === ex.id}
                        className="text-danger text-[11px] underline decoration-dotted"
                      >
                        delete
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </Card>

      {drilldownOpen && profit && fromIso && toIso && (
        <ProfitDrilldownModal
          profit={profit}
          from={new Date(fromIso)}
          to={new Date(toIso)}
          periodLabel={periodLabel ?? 'this period'}
          initialLevel="expenses"
          onClose={() => setDrilldownOpen(false)}
        />
      )}
    </div>
  );
}
