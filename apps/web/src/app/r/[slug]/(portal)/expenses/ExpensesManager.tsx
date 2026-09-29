'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { usePortalSupabase } from '@/components/PortalProvider';
import { Button, Card, Field, Input, Select } from '@/components/ui';
import { StatCard } from '@/components/StatCard';
import { formatCents } from '@/lib/format';
import { ProfitDrilldownModal } from '@/components/ProfitDrilldown';
import { ExpenseCalculator } from './ExpenseCalculator';
import {
  ResponsiveContainer,
  ComposedChart,
  Area,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ReferenceLine,
} from 'recharts';

export type Expense = {
  id: string;
  category: string;
  description: string | null;
  amount_cents: number;
  expense_date: string;
  supplier_id?: string | null;
};

export type ExpenseSupplier = { id: string; name: string };

export type DaySalesRow = {
  business_date: string;
  net_sales_cents: number;
  gross_sales_cents: number;
  discount_cents: number;
  refunded_cents: number;
  orders_count: number;
};

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

const CATEGORY_COLORS: Record<string, string> = {
  Rent: '#6366f1',
  Utilities: '#0ea5e9',
  Labor: '#f59e0b',
  Marketing: '#ec4899',
  Maintenance: '#8b5cf6',
  Supplies: '#14b8a6',
  Other: '#64748b',
};

// Date string helpers (YYYY-MM-DD)
const normalizeDateStr = (s?: string | null) => (s ? s.split('T')[0] : '');

function getDatesInRange(startStr?: string, endStr?: string): string[] {
  const dates: string[] = [];
  if (!startStr || !endStr) return dates;
  const s = normalizeDateStr(startStr);
  const e = normalizeDateStr(endStr);
  if (!s || !e) return dates;
  const cur = new Date(`${s}T00:00:00`);
  const end = new Date(`${e}T00:00:00`);
  if (isNaN(cur.getTime()) || isNaN(end.getTime()) || cur > end) return dates;
  while (cur <= end) {
    const y = cur.getFullYear();
    const m = String(cur.getMonth() + 1).padStart(2, '0');
    const d = String(cur.getDate()).padStart(2, '0');
    dates.push(`${y}-${m}-${d}`);
    cur.setDate(cur.getDate() + 1);
  }
  return dates;
}

// Today's LOCAL date
const todayLocal = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

const emptyForm = () => ({
  category: CATEGORIES[0],
  description: '',
  amount: '',
  expense_date: todayLocal(),
  supplier_id: '',
});

const pct = (n: number | null | undefined) => (n == null ? '—' : `${n}%`);

export function ExpensesManager({
  slug,
  restaurantName,
  expenses,
  profit,
  dailySales = [],
  activePeriod = '1_month',
  periodFromIso,
  periodToIso,
  fromStr,
  toStr,
  periodLabel,
  canWrite,
  canDelete,
  canViewProfit,
  suppliers = [],
}: {
  slug?: string;
  restaurantName?: string;
  expenses: Expense[];
  profit: ProfitRow | null;
  dailySales?: DaySalesRow[];
  activePeriod?: '1_month' | '2_months' | 'custom';
  periodFromIso: string;
  periodToIso: string;
  fromStr?: string;
  toStr?: string;
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
  const [downloadingPdf, setDownloadingPdf] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [editId, setEditId] = useState<string | null>(null);
  const [categoryFilter, setCategoryFilter] = useState('');
  const [drilldownLevel, setDrilldownLevel] = useState<'net_profit' | 'gross_profit' | 'expenses' | null>(null);

  // Profit graph controls
  const [chartMode, setChartMode] = useState<'daily' | 'cumulative'>('daily');
  const [customRangeFrom, setCustomRangeFrom] = useState(fromStr || '');
  const [customRangeTo, setCustomRangeTo] = useState(toStr || '');

  // Realtime subscription to live updates (expenses, orders, payments)
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const bump = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        router.refresh();
      }, 700);
    };
    let ch = supabase.channel('expenses-manager-live');
    for (const table of ['expenses', 'orders', 'payments']) {
      ch = ch.on('postgres_changes', { event: '*', schema: 'public', table }, bump);
    }
    ch.subscribe();
    return () => {
      if (timer) clearTimeout(timer);
      supabase.removeChannel(ch);
    };
  }, [supabase, router]);

  async function handleDownloadPdf() {
    setDownloadingPdf(true);
    setError(null);
    try {
      const { generateReportPdf } = await import('@/lib/generateReport');
      const reportData = {
        restaurantName: restaurantName || 'Restaurant',
        periodLabel,
        kpis: {
          net_sales_cents: profit?.net_sales_cents ?? 0,
          orders_count: profit?.orders_count ?? 0,
          aov_cents: profit && profit.orders_count > 0 ? Math.round(profit.net_sales_cents / profit.orders_count) : 0,
          gross_profit_cents: profit?.gross_profit_cents ?? 0,
          food_cost_pct:
            profit && profit.net_sales_cents > 0
              ? Math.round((profit.theoretical_cogs_cents / profit.net_sales_cents) * 100)
              : null,
          avg_rating: null,
        },
        profitDetail: profit
          ? {
              gross_sales_cents: profit.gross_sales_cents,
              discount_cents: profit.discount_cents,
              refunded_cents: profit.refunded_cents,
              net_sales_cents: profit.net_sales_cents,
              theoretical_cogs_cents: profit.theoretical_cogs_cents,
              cogs_lines_total: (profit as unknown as { cogs_lines_total?: number }).cogs_lines_total ?? 0,
              cogs_lines_missing: (profit as unknown as { cogs_lines_missing?: number }).cogs_lines_missing ?? 0,
              gross_profit_cents: profit.gross_profit_cents,
              gross_margin_pct: profit.gross_margin_pct,
              actual_cogs_cents: (profit as unknown as { actual_cogs_cents?: number }).actual_cogs_cents ?? profit.theoretical_cogs_cents,
              cogs_variance_cents: (profit as unknown as { cogs_variance_cents?: number }).cogs_variance_cents ?? 0,
              expenses_cents: profit.expenses_cents,
              net_profit_cents: profit.net_profit_cents,
              net_profit_margin_pct: profit.net_profit_margin_pct,
            }
          : null,
        dailySales: (dailySales || []).map((d) => ({
          business_date: d.business_date,
          net_sales_cents: d.net_sales_cents,
        })),
        topProducts: [],
        expenseRecords: expenses.map((e) => ({
          category: e.category,
          description: e.description,
          amount_cents: e.amount_cents,
          expense_date: e.expense_date,
        })),
        categoryMix: [],
        paymentMix: [],
        feedback: null,
        attendance: null,
        aiSummary: null,
      };

      await generateReportPdf(reportData, {
        sections: ['sales_trend', 'expenses'],
        domain: 'expenses',
      });
    } catch (err) {
      console.error('Failed to generate PDF:', err);
      setError('Could not generate the Profit & Financial PDF.');
    } finally {
      setDownloadingPdf(false);
    }
  }

  const set = (k: keyof ReturnType<typeof emptyForm>, v: string) => setForm((f) => ({ ...f, [k]: v }));

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
      setForm(emptyForm());
      setEditId(null);
    }
  }

  async function remove(id: string) {
    if (!window.confirm('Delete this expense?')) return;
    await run(() => supabase.from('expenses').delete().eq('id', id));
  }

  // Filtered expenses list
  const filtered = useMemo(
    () => (categoryFilter ? expenses.filter((ex) => ex.category === categoryFilter) : expenses),
    [expenses, categoryFilter],
  );
  const filteredTotal = useMemo(() => filtered.reduce((s, ex) => s + ex.amount_cents, 0), [filtered]);
  const categoriesInUse = useMemo(
    () => Array.from(new Set(expenses.map((ex) => ex.category))).sort(),
    [expenses],
  );

  // Period navigation
  function switchPeriod(p: '1_month' | '2_months' | 'custom') {
    if (!slug) return;
    if (p === 'custom') {
      const from = customRangeFrom || fromStr || todayLocal();
      const to = customRangeTo || toStr || todayLocal();
      router.push(`/r/${slug}/expenses?period=custom&from=${from}&to=${to}`);
    } else {
      router.push(`/r/${slug}/expenses?period=${p}`);
    }
  }

  function applyCustomRange(e: React.FormEvent) {
    e.preventDefault();
    if (!slug || !customRangeFrom || !customRangeTo) return;
    router.push(`/r/${slug}/expenses?period=custom&from=${customRangeFrom}&to=${customRangeTo}`);
  }

  // Daily expenses aggregated with date normalization
  const expensesByDate = useMemo(() => {
    const map = new Map<string, number>();
    for (const ex of expenses) {
      const k = normalizeDateStr(ex.expense_date);
      if (k) map.set(k, (map.get(k) ?? 0) + ex.amount_cents);
    }
    return map;
  }, [expenses]);

  // Daily sales map with date normalization
  const salesByDate = useMemo(() => {
    const map = new Map<string, DaySalesRow>();
    for (const d of dailySales) {
      const k = normalizeDateStr(d.business_date);
      if (k) map.set(k, d);
    }
    return map;
  }, [dailySales]);

  // All calendar dates across active period
  const allPeriodDates = useMemo(() => {
    const range = getDatesInRange(fromStr, toStr);
    if (range.length > 0) return range;
    if (dailySales && dailySales.length > 0) {
      return dailySales.map((d) => normalizeDateStr(d.business_date)).filter(Boolean);
    }
    return [];
  }, [fromStr, toStr, dailySales]);

  // Combined chart dataset
  const chartData = useMemo(() => {
    if (allPeriodDates.length === 0) return [];
    let runningNetSales = 0;
    let runningExpenses = 0;
    let runningProfit = 0;

    const cogsRatio =
      profit && profit.net_sales_cents > 0 ? profit.theoretical_cogs_cents / profit.net_sales_cents : 0.3;

    return allPeriodDates.map((dateKey) => {
      const d = salesByDate.get(dateKey);
      const daySales = d ? d.net_sales_cents / 100 : 0;
      const dayExpenses = (expensesByDate.get(dateKey) ?? 0) / 100;
      const dayCogs = daySales * cogsRatio;
      const dayNetProfit = daySales - dayCogs - dayExpenses;

      runningNetSales += daySales;
      runningExpenses += dayExpenses;
      runningProfit += dayNetProfit;

      const dateObj = new Date(`${dateKey}T00:00:00`);
      const shortDate = isNaN(dateObj.getTime())
        ? dateKey
        : dateObj.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

      return {
        date: shortDate,
        fullDate: dateKey,
        netSales: Math.round(daySales * 100) / 100,
        expenses: Math.round(dayExpenses * 100) / 100,
        netProfit: Math.round(dayNetProfit * 100) / 100,
        cumNetSales: Math.round(runningNetSales * 100) / 100,
        cumExpenses: Math.round(runningExpenses * 100) / 100,
        cumNetProfit: Math.round(runningProfit * 100) / 100,
      };
    });
  }, [allPeriodDates, salesByDate, expensesByDate, profit]);

  const yDomain = useMemo(() => {
    if (!chartData || chartData.length === 0) return [0, 100];
    const keys =
      chartMode === 'daily'
        ? (['netSales', 'expenses', 'netProfit'] as const)
        : (['cumNetSales', 'cumExpenses', 'cumNetProfit'] as const);
    let min = 0;
    let max = 0;
    for (const d of chartData) {
      for (const k of keys) {
        const val = Number(d[k]) || 0;
        if (val < min) min = val;
        if (val > max) max = val;
      }
    }
    if (min === 0 && max === 0) {
      return [0, 100];
    }
    const range = max - min;
    const pad = Math.max(10, Math.ceil(range * 0.15));
    const lower = min < 0 ? Math.floor((min - pad) / 10) * 10 : 0;
    const upper = Math.ceil((max + pad) / 10) * 10;
    return [lower, upper];
  }, [chartData, chartMode]);

  const hasChartActivity = useMemo(() => {
    return chartData.some((d) => d.netSales > 0 || d.expenses > 0 || d.netProfit !== 0);
  }, [chartData]);

  // Expense breakdown by category
  const categoryTotals = useMemo(() => {
    const map = new Map<string, number>();
    for (const ex of expenses) {
      map.set(ex.category, (map.get(ex.category) ?? 0) + ex.amount_cents);
    }
    const total = Array.from(map.values()).reduce((a, b) => a + b, 0);
    return CATEGORIES.map((cat) => {
      const cents = map.get(cat) ?? 0;
      const p = total > 0 ? (cents / total) * 100 : 0;
      return { category: cat, cents, pct: Math.round(p * 10) / 10 };
    }).filter((c) => c.cents > 0);
  }, [expenses]);

  const totalExpensesCents = useMemo(
    () => categoryTotals.reduce((s, c) => s + c.cents, 0),
    [categoryTotals],
  );

  return (
    <div className="space-y-8">
      {error && (
        <div className="rounded border border-danger/40 bg-danger/10 text-danger p-3 text-xs">{error}</div>
      )}

      {/* Period Filter Tabs */}
      <div className="flex flex-wrap items-center justify-between gap-4 p-4 rounded-xl border border-border bg-main/40">
        <div className="flex items-center gap-1.5 p-1 rounded-lg bg-main border border-border/80 text-xs">
          <button
            onClick={() => switchPeriod('1_month')}
            className={`px-3 py-1.5 rounded-md font-semibold transition-colors ${
              activePeriod === '1_month'
                ? 'bg-primary text-primary-fg shadow-sm'
                : 'text-muted hover:text-body'
            }`}
          >
            1 Month
          </button>
          <button
            onClick={() => switchPeriod('2_months')}
            className={`px-3 py-1.5 rounded-md font-semibold transition-colors ${
              activePeriod === '2_months'
                ? 'bg-primary text-primary-fg shadow-sm'
                : 'text-muted hover:text-body'
            }`}
          >
            2 Months
          </button>
          <button
            onClick={() => switchPeriod('custom')}
            className={`px-3 py-1.5 rounded-md font-semibold transition-colors ${
              activePeriod === 'custom'
                ? 'bg-primary text-primary-fg shadow-sm'
                : 'text-muted hover:text-body'
            }`}
          >
            Custom Date
          </button>
        </div>

        {activePeriod === 'custom' && (
          <form onSubmit={applyCustomRange} className="flex flex-wrap items-center gap-2 text-xs">
            <span className="text-muted">From:</span>
            <input
              type="date"
              value={customRangeFrom}
              onChange={(e) => setCustomRangeFrom(e.target.value)}
              className="rounded-md border border-border bg-surface px-2.5 py-1 text-xs"
              required
            />
            <span className="text-muted">To:</span>
            <input
              type="date"
              value={customRangeTo}
              onChange={(e) => setCustomRangeTo(e.target.value)}
              className="rounded-md border border-border bg-surface px-2.5 py-1 text-xs"
              required
            />
            <Button type="submit" variant="primary" className="py-1 px-3 text-xs h-auto">
              Apply
            </Button>
          </form>
        )}

        <div className="flex flex-wrap items-center gap-3">
          <div className="text-xs text-muted font-medium">
            Active range: <span className="text-body font-bold">{periodLabel}</span>
          </div>
          <Button
            type="button"
            variant="ghost"
            onClick={handleDownloadPdf}
            disabled={downloadingPdf}
            className="text-xs py-1.5 px-3 h-auto border border-border bg-surface hover:bg-main font-semibold shadow-sm flex items-center gap-1.5"
          >
            <span>{downloadingPdf ? '⏳ Generating PDF…' : '📄 Download Profit PDF'}</span>
          </Button>
        </div>
      </div>

      {/* KPI Cards */}
      {canViewProfit && profit && (
        <section>
          <div className="flex items-center justify-between mb-3">
            <h2 className="font-bold text-sm">Financial Executive Summary ({periodLabel})</h2>
            <div className="text-xs text-muted">{profit.orders_count} orders completed</div>
          </div>
          <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
            <StatCard
              label="Net Sales"
              value={formatCents(profit.net_sales_cents)}
              hint={`Gross: ${formatCents(profit.gross_sales_cents)}`}
            />
            <StatCard
              label="Cost of Goods (COGS)"
              value={formatCents(profit.theoretical_cogs_cents)}
              hint={`${profit.net_sales_cents > 0 ? Math.round((profit.theoretical_cogs_cents / profit.net_sales_cents) * 100) : 0}% food cost`}
            />
            <button
              onClick={() => setDrilldownLevel('gross_profit')}
              className="text-left rounded-lg hover:ring-2 hover:ring-primary/40 transition-shadow"
            >
              <StatCard
                label="Gross Profit ↴"
                value={formatCents(profit.gross_profit_cents)}
                hint={`${pct(profit.gross_margin_pct)} margin`}
                tone="ok"
              />
            </button>
            <button
              onClick={() => setDrilldownLevel('expenses')}
              className="text-left rounded-lg hover:ring-2 hover:ring-primary/40 transition-shadow"
            >
              <StatCard
                label="Operating Expenses ↴"
                value={formatCents(profit.expenses_cents)}
                hint={`${expenses.length} records`}
                tone={profit.expenses_cents > 0 ? 'warn' : 'default'}
              />
            </button>
            <button
              onClick={() => setDrilldownLevel('net_profit')}
              className="text-left rounded-lg hover:ring-2 hover:ring-primary/40 transition-shadow"
            >
              <StatCard
                label="Net Profit ↴"
                value={formatCents(profit.net_profit_cents)}
                hint={`${pct(profit.net_profit_margin_pct)} net margin`}
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

      {/* Professional Profit Analytics Graph */}
      {canViewProfit && chartData.length > 0 && (
        <Card className="p-4 sm:p-5">
          <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
            <div>
              <h2 className="font-bold text-sm">Profit & Financial Analytics</h2>
              <p className="text-muted text-xs mt-0.5">
                Visual trajectory of Net Sales, Operating Expenses, and Net Profit across {periodLabel}.
              </p>
            </div>
            <div className="flex items-center gap-1.5 p-1 rounded-lg bg-main border border-border text-xs">
              <button
                onClick={() => setChartMode('daily')}
                className={`px-2.5 py-1 rounded font-semibold transition-colors ${
                  chartMode === 'daily' ? 'bg-primary text-primary-fg' : 'text-muted hover:text-body'
                }`}
              >
                Daily Performance
              </button>
              <button
                onClick={() => setChartMode('cumulative')}
                className={`px-2.5 py-1 rounded font-semibold transition-colors ${
                  chartMode === 'cumulative' ? 'bg-primary text-primary-fg' : 'text-muted hover:text-body'
                }`}
              >
                Cumulative Growth
              </button>
            </div>
          </div>

          <div className="h-72 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={chartData} margin={{ top: 12, right: 16, left: 10, bottom: 0 }}>
                <defs>
                  <linearGradient id="salesGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#10b981" stopOpacity={0.35} />
                    <stop offset="95%" stopColor="#10b981" stopOpacity={0.0} />
                  </linearGradient>
                  <linearGradient id="expenseGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#f43f5e" stopOpacity={0.35} />
                    <stop offset="95%" stopColor="#f43f5e" stopOpacity={0.0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.08)" vertical={false} />
                <XAxis
                  dataKey="date"
                  stroke="rgba(255,255,255,0.4)"
                  fontSize={11}
                  tickLine={false}
                  interval="preserveStartEnd"
                  minTickGap={20}
                />
                <YAxis
                  stroke="rgba(255,255,255,0.4)"
                  fontSize={11}
                  tickLine={false}
                  width={65}
                  domain={yDomain}
                  tickFormatter={(v) => (v < 0 ? `-$${Math.abs(v)}` : `$${v}`)}
                />
                <ReferenceLine y={0} stroke="rgba(255,255,255,0.25)" strokeDasharray="3 3" />
                <Tooltip
                  content={({ active, payload, label }) => {
                    if (!active || !payload || payload.length === 0) return null;
                    const d = payload[0]?.payload;
                    if (!d) return null;
                    return (
                      <div className="rounded-lg border border-border bg-surface p-3 shadow-xl text-xs space-y-1">
                        <div className="font-bold text-body border-b border-border pb-1">
                          {d.fullDate || label}
                        </div>
                        <div className="flex justify-between gap-4 text-ok">
                          <span>Net Sales:</span>
                          <span className="font-mono font-bold">
                            ${(chartMode === 'daily' ? d.netSales : d.cumNetSales).toLocaleString()}
                          </span>
                        </div>
                        <div className="flex justify-between gap-4 text-danger">
                          <span>Expenses:</span>
                          <span className="font-mono font-bold">
                            ${(chartMode === 'daily' ? d.expenses : d.cumExpenses).toLocaleString()}
                          </span>
                        </div>
                        <div className="flex justify-between gap-4 text-primary pt-1 border-t border-border">
                          <span>Net Profit:</span>
                          <span className="font-mono font-bold">
                            ${(chartMode === 'daily' ? d.netProfit : d.cumNetProfit).toLocaleString()}
                          </span>
                        </div>
                      </div>
                    );
                  }}
                />
                {chartMode === 'daily' ? (
                  <>
                    <Area
                      type="monotone"
                      dataKey="netSales"
                      name="Net Sales"
                      stroke="#10b981"
                      strokeWidth={2}
                      fillOpacity={1}
                      fill="url(#salesGrad)"
                    />
                    <Area
                      type="monotone"
                      dataKey="expenses"
                      name="Expenses"
                      stroke="#f43f5e"
                      strokeWidth={2}
                      fillOpacity={1}
                      fill="url(#expenseGrad)"
                    />
                    <Line
                      type="monotone"
                      dataKey="netProfit"
                      name="Net Profit"
                      stroke="#6366f1"
                      strokeWidth={2.5}
                      dot={{ r: 2, fill: '#6366f1' }}
                      activeDot={{ r: 5 }}
                    />
                  </>
                ) : (
                  <>
                    <Area
                      type="monotone"
                      dataKey="cumNetSales"
                      name="Cumulative Sales"
                      stroke="#10b981"
                      strokeWidth={2}
                      fillOpacity={1}
                      fill="url(#salesGrad)"
                    />
                    <Area
                      type="monotone"
                      dataKey="cumExpenses"
                      name="Cumulative Expenses"
                      stroke="#f43f5e"
                      strokeWidth={2}
                      fillOpacity={1}
                      fill="url(#expenseGrad)"
                    />
                    <Line
                      type="monotone"
                      dataKey="cumNetProfit"
                      name="Cumulative Profit"
                      stroke="#6366f1"
                      strokeWidth={2.5}
                      dot={{ r: 2, fill: '#6366f1' }}
                      activeDot={{ r: 5 }}
                    />
                  </>
                )}
              </ComposedChart>
            </ResponsiveContainer>
          </div>

          {!hasChartActivity && (
            <div className="mt-3 text-center text-xs text-muted/80 bg-main/40 border border-border/50 rounded-lg py-2">
              No revenue or expense records found for this period yet. Data automatically plots live as sales and expenses are recorded.
            </div>
          )}

          <div className="flex items-center justify-center gap-6 mt-3 text-xs">
            <div className="flex items-center gap-1.5">
              <span className="inline-block w-3 h-3 rounded-full bg-[#10b981]" />
              <span className="text-muted">Net Sales</span>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="inline-block w-3 h-3 rounded-full bg-[#f43f5e]" />
              <span className="text-muted">Operating Expenses</span>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="inline-block w-3 h-3 rounded-full bg-[#6366f1]" />
              <span className="text-muted">Net Profit</span>
            </div>
          </div>
        </Card>
      )}

      {/* Professional P&L Statement Breakdown Table */}
      {canViewProfit && profit && (
        <Card className="p-0 overflow-hidden">
          <div className="p-4 border-b border-border bg-main/30 flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="font-bold text-sm">Profit &amp; Loss (P&amp;L) Statement</h2>
              <p className="text-muted text-xs">Authoritative accounting waterfall for {periodLabel}.</p>
            </div>
            <Button
              type="button"
              variant="ghost"
              onClick={handleDownloadPdf}
              disabled={downloadingPdf}
              className="text-xs py-1 px-3 h-auto border border-border bg-surface hover:bg-main font-medium flex items-center gap-1.5"
            >
              <span>{downloadingPdf ? '⏳ Generating…' : '📄 Export P&L PDF'}</span>
            </Button>
          </div>
          <table className="w-full text-left text-xs">
            <thead className="text-muted border-b border-border bg-main/50">
              <tr>
                <th className="p-3 font-semibold">Financial Line</th>
                <th className="p-3 font-semibold text-right">Amount</th>
                <th className="p-3 font-semibold text-right">% of Net Sales</th>
              </tr>
            </thead>
            <tbody>
              <tr className="border-b border-border/50">
                <td className="p-3 font-semibold text-body">Operating Revenue (Net Sales)</td>
                <td className="p-3 font-mono font-bold text-right">{formatCents(profit.net_sales_cents)}</td>
                <td className="p-3 font-mono text-right text-muted">100.0%</td>
              </tr>
              <tr className="border-b border-border/50 bg-main/20">
                <td className="p-3 pl-6 text-muted">Less: Cost of Goods Sold (Theoretical COGS)</td>
                <td className="p-3 font-mono text-right text-muted">-{formatCents(profit.theoretical_cogs_cents)}</td>
                <td className="p-3 font-mono text-right text-muted">
                  -{profit.net_sales_cents > 0 ? ((profit.theoretical_cogs_cents / profit.net_sales_cents) * 100).toFixed(1) : 0}%
                </td>
              </tr>
              <tr className="border-b border-border/80 font-bold bg-ok/5">
                <td className="p-3 text-ok">Gross Profit</td>
                <td className="p-3 font-mono text-right text-ok">{formatCents(profit.gross_profit_cents)}</td>
                <td className="p-3 font-mono text-right text-ok">{pct(profit.gross_margin_pct)}</td>
              </tr>
              {categoryTotals.map((c) => (
                <tr key={c.category} className="border-b border-border/30">
                  <td className="p-3 pl-6 text-muted">Less: {c.category}</td>
                  <td className="p-3 font-mono text-right text-muted">-{formatCents(c.cents)}</td>
                  <td className="p-3 font-mono text-right text-muted">
                    -{profit.net_sales_cents > 0 ? ((c.cents / profit.net_sales_cents) * 100).toFixed(1) : 0}%
                  </td>
                </tr>
              ))}
              <tr className="border-b border-border/80 font-bold bg-warn/5">
                <td className="p-3 text-warn">Total Operating Expenses</td>
                <td className="p-3 font-mono text-right text-warn">-{formatCents(profit.expenses_cents)}</td>
                <td className="p-3 font-mono text-right text-warn">
                  -{profit.net_sales_cents > 0 ? ((profit.expenses_cents / profit.net_sales_cents) * 100).toFixed(1) : 0}%
                </td>
              </tr>
              <tr className={`font-black text-sm ${profit.net_profit_cents >= 0 ? 'bg-ok/10 text-ok' : 'bg-danger/10 text-danger'}`}>
                <td className="p-4">Net Profit</td>
                <td className="p-4 font-mono text-right">{formatCents(profit.net_profit_cents)}</td>
                <td className="p-4 font-mono text-right">{pct(profit.net_profit_margin_pct)}</td>
              </tr>
            </tbody>
          </table>
        </Card>
      )}

      {/* Expense Category Distribution Bar */}
      {categoryTotals.length > 0 && (
        <Card className="p-4">
          <div className="flex items-center justify-between mb-2">
            <h2 className="font-bold text-xs">Expense Breakdown by Category ({formatCents(totalExpensesCents)})</h2>
            <span className="text-[11px] text-muted">Click a category to filter table below</span>
          </div>
          <div className="w-full h-3 rounded-full bg-main overflow-hidden flex">
            {categoryTotals.map((c) => (
              <div
                key={c.category}
                style={{
                  width: `${c.pct}%`,
                  backgroundColor: CATEGORY_COLORS[c.category] || '#64748b',
                }}
                className="h-full cursor-pointer hover:opacity-80 transition-opacity"
                title={`${c.category}: ${formatCents(c.cents)} (${c.pct}%)`}
                onClick={() => setCategoryFilter(categoryFilter === c.category ? '' : c.category)}
              />
            ))}
          </div>
          <div className="flex flex-wrap gap-x-4 gap-y-1.5 mt-3 text-xs">
            {categoryTotals.map((c) => (
              <button
                key={c.category}
                onClick={() => setCategoryFilter(categoryFilter === c.category ? '' : c.category)}
                className={`flex items-center gap-1.5 rounded px-2 py-0.5 transition-colors ${
                  categoryFilter === c.category ? 'bg-primary/20 text-primary font-bold' : 'text-muted hover:text-body'
                }`}
              >
                <span
                  className="w-2.5 h-2.5 rounded-full shrink-0"
                  style={{ backgroundColor: CATEGORY_COLORS[c.category] || '#64748b' }}
                />
                <span>{c.category}:</span>
                <span className="font-mono font-medium">{formatCents(c.cents)}</span>
                <span className="text-[10px] text-muted">({c.pct}%)</span>
              </button>
            ))}
          </div>
        </Card>
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
                    setForm(emptyForm());
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
          <h2 className="font-bold text-sm">All Recorded Expenses</h2>
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
