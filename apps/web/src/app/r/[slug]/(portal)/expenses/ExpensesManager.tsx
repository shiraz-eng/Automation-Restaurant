'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { usePortalSupabase } from '@/components/PortalProvider';
import { Button, Card, Field, Input, Select } from '@/components/ui';
import { StatCard } from '@/components/StatCard';
import { formatCents } from '@/lib/format';
import { ProfitDrilldownModal } from '@/components/ProfitDrilldown';
import { ExpenseCalculator } from './ExpenseCalculator';

export type Expense = {
  id: string;
  category: string;
  description: string | null;
  amount_cents: number;
  expense_date: string;
  supplier_id?: string | null;
};
export type ExpenseSupplier = { id: string; name: string };

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

const CATEGORIES = ['Rent', 'Utilities', 'Labor', 'Marketing', 'Maintenance', 'Supplies', 'Other'];

const EMPTY = {
  category: CATEGORIES[0],
  description: '',
  amount: '',
  expense_date: new Date().toISOString().slice(0, 10),
  supplier_id: '',
};

const pct = (n: number | null) => (n == null ? '—' : `${n}%`);

export function ExpensesManager({
  expenses,
  profit,
  periodFromIso,
  periodToIso,
  periodLabel,
  canWrite,
  canDelete,
  canViewProfit,
  suppliers = [],
}: {
  expenses: Expense[];
  profit: ProfitRow | null;
  periodFromIso: string;
  periodToIso: string;
  periodLabel: string;
  canWrite: boolean;
  canDelete: boolean;
  canViewProfit: boolean;
  suppliers?: ExpenseSupplier[];
}) {
  const router = useRouter();
  const supabase = usePortalSupabase();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState(EMPTY);
  const [editId, setEditId] = useState<string | null>(null);
  const [categoryFilter, setCategoryFilter] = useState('');
  const [drilldownLevel, setDrilldownLevel] = useState<'net_profit' | 'gross_profit' | 'expenses' | null>(null);

  const set = (k: keyof typeof EMPTY, v: string) => setForm((f) => ({ ...f, [k]: v }));

  async function run(fn: () => PromiseLike<{ error: { message: string } | null }>) {
    setBusy(true);
    setError(null);
    const { error } = await fn();
    setBusy(false);
    if (error) {
      setError(error.message);
      return false;
    }
    router.refresh();
    return true;
  }

  function startEdit(ex: Expense) {
    setEditId(ex.id);
    setForm({
      category: ex.category,
      description: ex.description ?? '',
      amount: (ex.amount_cents / 100).toFixed(2),
      expense_date: ex.expense_date,
      supplier_id: ex.supplier_id ?? '',
    });
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    const cents = Math.round(parseFloat(form.amount) * 100);
    if (!Number.isFinite(cents) || cents <= 0) {
      setError('Enter a valid amount.');
      return;
    }
    const row = {
      category: form.category,
      description: form.description.trim() || null,
      amount_cents: cents,
      expense_date: form.expense_date,
      supplier_id: form.supplier_id || null,
    };
    const ok = await run(() =>
      editId ? supabase.from('expenses').update(row).eq('id', editId) : supabase.from('expenses').insert(row),
    );
    if (ok) {
      setForm(EMPTY);
      setEditId(null);
    }
  }

  async function remove(id: string) {
    if (!window.confirm('Delete this expense?')) return;
    await run(() => supabase.from('expenses').delete().eq('id', id));
  }

  const filtered = useMemo(
    () => (categoryFilter ? expenses.filter((ex) => ex.category === categoryFilter) : expenses),
    [expenses, categoryFilter],
  );
  const filteredTotal = useMemo(() => filtered.reduce((s, ex) => s + ex.amount_cents, 0), [filtered]);
  const categoriesInUse = useMemo(
    () => Array.from(new Set(expenses.map((ex) => ex.category))).sort(),
    [expenses],
  );

  return (
    <div className="space-y-8">
      {error && (
        <div className="rounded border border-danger/40 bg-danger/10 text-danger p-3 text-xs">{error}</div>
      )}

      {canViewProfit && profit && (
        <section>
          <h2 className="font-bold text-sm mb-3">Profit impact ({periodLabel})</h2>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <StatCard label="Net sales" value={formatCents(profit.net_sales_cents)} hint={`${profit.orders_count} orders`} />
            <button
              onClick={() => setDrilldownLevel('gross_profit')}
              className="text-left rounded-lg hover:ring-2 hover:ring-primary/40 transition-shadow"
            >
              <StatCard label="Gross profit ↴" value={formatCents(profit.gross_profit_cents)} hint={`${pct(profit.gross_margin_pct)} margin`} tone="ok" />
            </button>
            <button
              onClick={() => setDrilldownLevel('expenses')}
              className="text-left rounded-lg hover:ring-2 hover:ring-primary/40 transition-shadow"
            >
              <StatCard label="Expenses ↴" value={formatCents(profit.expenses_cents)} tone={profit.expenses_cents > 0 ? 'warn' : 'default'} />
            </button>
            <button
              onClick={() => setDrilldownLevel('net_profit')}
              className="text-left rounded-lg hover:ring-2 hover:ring-primary/40 transition-shadow"
            >
              <StatCard
                label="Net profit ↴"
                value={formatCents(profit.net_profit_cents)}
                hint={pct(profit.net_profit_margin_pct)}
                tone={profit.net_profit_cents >= 0 ? 'ok' : 'danger'}
              />
            </button>
          </div>
          {drilldownLevel && (
            <ProfitDrilldownModal
              profit={profit}
              from={new Date(periodFromIso)}
              to={new Date(periodToIso)}
              periodLabel={periodLabel}
              initialLevel={drilldownLevel}
              onClose={() => setDrilldownLevel(null)}
            />
          )}
        </section>
      )}

      {canViewProfit && profit && <ExpenseCalculator profit={profit} periodLabel={periodLabel} />}

      {canWrite && (
        <Card>
          <h2 className="font-bold mb-3 text-sm">{editId ? 'Edit expense' : 'Add expense'}</h2>
          <form onSubmit={save} className="grid grid-cols-1 sm:grid-cols-6 gap-3 items-end">
            <Field label="Category">
              <Select value={form.category} onChange={(e) => set('category', e.target.value)}>
                {CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Supplier">
              <Select value={form.supplier_id} onChange={(e) => set('supplier_id', e.target.value)}>
                <option value="">— none —</option>
                {suppliers.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Description">
              <Input value={form.description} onChange={(e) => set('description', e.target.value)} placeholder="optional" />
            </Field>
            <Field label="Amount">
              <Input type="number" min="0.01" step="0.01" value={form.amount} onChange={(e) => set('amount', e.target.value)} />
            </Field>
            <Field label="Date">
              <Input type="date" value={form.expense_date} onChange={(e) => set('expense_date', e.target.value)} />
            </Field>
            <div className="flex gap-2">
              <Button type="submit" disabled={busy}>
                {editId ? 'Save' : 'Add'}
              </Button>
              {editId && (
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => {
                    setEditId(null);
                    setForm(EMPTY);
                  }}
                >
                  Cancel
                </Button>
              )}
            </div>
          </form>
        </Card>
      )}

      <section>
        <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
          <h2 className="font-bold text-sm">All expenses</h2>
          <div className="flex items-center gap-2 text-xs">
            <span className="text-muted">Filter:</span>
            <select
              value={categoryFilter}
              onChange={(e) => setCategoryFilter(e.target.value)}
              className="rounded-md border border-border bg-surface px-2 py-1.5 text-xs"
            >
              <option value="">All categories</option>
              {categoriesInUse.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </div>
        </div>

        <Card className="p-0 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="text-muted border-b border-border">
                <tr>
                  <th className="p-3 font-semibold">Date</th>
                  <th className="p-3 font-semibold">Category</th>
                  <th className="p-3 font-semibold">Description</th>
                  <th className="p-3 font-semibold text-right">Amount</th>
                  {(canWrite || canDelete) && <th className="p-3" />}
                </tr>
              </thead>
              <tbody>
                {filtered.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="p-3 text-muted">
                      {expenses.length === 0 ? 'No expenses recorded yet.' : 'No expenses in this category.'}
                    </td>
                  </tr>
                ) : (
                  filtered.map((ex) => (
                    <tr key={ex.id} className="border-b border-border/60 last:border-0">
                      <td className="p-3 text-muted">{ex.expense_date}</td>
                      <td className="p-3 font-semibold">{ex.category}</td>
                      <td className="p-3 text-muted">
                        {ex.description ?? '—'}
                        {ex.supplier_id && (
                          <span className="text-primary text-[10px] font-semibold ml-1.5">
                            · {suppliers.find((s) => s.id === ex.supplier_id)?.name ?? 'supplier'}
                          </span>
                        )}
                      </td>
                      <td className="p-3 text-right font-mono">{formatCents(ex.amount_cents)}</td>
                      {(canWrite || canDelete) && (
                        <td className="p-3 text-right whitespace-nowrap">
                          {canWrite && (
                            <Button variant="ghost" disabled={busy} onClick={() => startEdit(ex)}>
                              Edit
                            </Button>
                          )}
                          {canDelete && (
                            <Button variant="danger" className="ml-1.5" disabled={busy} onClick={() => remove(ex.id)}>
                              Delete
                            </Button>
                          )}
                        </td>
                      )}
                    </tr>
                  ))
                )}
              </tbody>
              {filtered.length > 0 && (
                <tfoot>
                  <tr className="border-t border-border bg-main/60">
                    <td className="p-3 font-semibold" colSpan={3}>
                      {categoryFilter || 'Total'} ({filtered.length})
                    </td>
                    <td className="p-3 text-right font-mono font-bold">{formatCents(filteredTotal)}</td>
                    {(canWrite || canDelete) && <td className="p-3" />}
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
        </Card>
      </section>
    </div>
  );
}
