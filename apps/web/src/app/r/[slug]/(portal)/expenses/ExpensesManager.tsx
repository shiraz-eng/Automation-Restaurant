'use client';

import { Fragment, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { usePortalSupabase } from '@/components/PortalProvider';
import { Button, Card, Field, Input, Select } from '@/components/ui';
import { StatCard } from '@/components/StatCard';
import { formatCents, axisMoney } from '@/lib/format';
import { ProfitDrilldownModal } from '@/components/ProfitDrilldown';
import { ExpenseCalculator } from './ExpenseCalculator';
import {
  ResponsiveContainer,
  ComposedChart,
  Area,
  Bar,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ReferenceLine,
} from 'recharts';

import { isPostedExpense, type Expense, type ExpenseStatus } from './expenseShared';
import { monthLabel } from '@/lib/financePeriod';

export type { Expense, ExpenseStatus } from './expenseShared';

const STATUS_LABEL: Record<ExpenseStatus, string> = {
  draft: 'Draft',
  submitted: 'Awaiting approval',
  approved: 'Approved · unpaid',
  rejected: 'Rejected',
  paid: 'Paid',
  void: 'Void',
};
const STATUS_TONE: Record<ExpenseStatus, string> = {
  draft: 'bg-muted/15 text-muted',
  submitted: 'bg-warn/15 text-warn',
  approved: 'bg-primary/15 text-primary',
  rejected: 'bg-danger/15 text-danger',
  paid: 'bg-ok/15 text-ok',
  void: 'bg-muted/15 text-muted line-through',
};
const PAYMENT_METHODS: { value: string; label: string }[] = [
  { value: 'bank_transfer', label: 'Bank transfer' },
  { value: 'cash', label: 'Cash' },
  { value: 'card', label: 'Card' },
  { value: 'cheque', label: 'Cheque' },
  { value: 'digital_wallet', label: 'Digital wallet' },
  { value: 'other', label: 'Other' },
];

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
const normalizeDateStr = (s?: string | Date | null) => {
  if (!s) return '';
  if (s instanceof Date) {
    const y = s.getFullYear();
    const m = String(s.getMonth() + 1).padStart(2, '0');
    const d = String(s.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  return String(s).trim().slice(0, 10);
};

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
  vendor: '',
});

const pct = (n: number | null | undefined) => (n == null ? '—' : `${n}%`);

export function ExpensesManager({
  slug,
  restaurantName,
  expenses,
  profit,
  dailySales = [],
  periodBar,
  openSummary,
  periodFromIso,
  periodToIso,
  fromStr,
  toStr,
  periodLabel,
  canWrite,
  canDelete,
  canViewProfit,
  canApprove = false,
  canPay = false,
  suppliers = [],
}: {
  slug?: string;
  restaurantName?: string;
  expenses: Expense[];
  profit: ProfitRow | null;
  dailySales?: DaySalesRow[];
  /** The shared Finance date picker (the Expenses page passes it; custom portals show a fixed period). */
  periodBar?: React.ReactNode;
  /** Expenses awaiting approval / payment across ALL dates (the list itself only holds the chosen period). */
  openSummary?: { awaiting: number; awaitingCents: number; unpaid: number; unpaidCents: number };
  periodFromIso: string;
  periodToIso: string;
  fromStr?: string;
  toStr?: string;
  periodLabel: string;
  canWrite: boolean;
  canDelete: boolean;
  canViewProfit: boolean;
  /** finance.approve_expense — approve, reject and void (approve_/reject_/void_expense()). */
  canApprove?: boolean;
  /** finance.pay_expense — mark approved expenses paid (pay_expense()). */
  canPay?: boolean;
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
  const [statusFilter, setStatusFilter] = useState<'' | ExpenseStatus>('');
  const [sortKey, setSortKey] = useState<'newest' | 'oldest' | 'amount_desc' | 'amount_asc' | 'category'>('newest');
  const [receipt, setReceipt] = useState<File | null>(null);
  const [payFor, setPayFor] = useState<Expense | null>(null);
  const [payMethod, setPayMethod] = useState('bank_transfer');
  const [payRef, setPayRef] = useState('');
  const [payDate, setPayDate] = useState(todayLocal());
  const [drilldownLevel, setDrilldownLevel] = useState<'net_profit' | 'gross_profit' | 'expenses' | null>(null);

  // Profit graph controls
  const [chartMode, setChartMode] = useState<'daily' | 'cumulative'>('daily');

  // Client hydration flag for safe ResponsiveContainer mounting
  const [isMounted, setIsMounted] = useState(false);
  useEffect(() => {
    setIsMounted(true);
  }, []);

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
        expenseRecords: expenses.filter(isPostedExpense).map((e) => ({
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
    setReceipt(null);
    setForm({
      category: ex.category,
      description: ex.description ?? '',
      amount: (ex.amount_cents / 100).toFixed(2),
      expense_date: ex.expense_date,
      supplier_id: ex.supplier_id ?? '',
      vendor: ex.vendor ?? '',
    });
  }

  async function uploadReceipt(expenseId: string, file: File): Promise<string | null> {
    const safe = file.name.replace(/[^A-Za-z0-9._-]+/g, '_').slice(-80) || 'receipt';
    const path = `${expenseId}/${Date.now()}-${safe}`;
    const { error: upErr } = await supabase.storage.from('expense-receipts').upload(path, file, { contentType: file.type });
    if (upErr) return upErr.message;
    const { error: linkErr } = await supabase.from('expenses').update({ attachment_path: path }).eq('id', expenseId);
    return linkErr ? linkErr.message : null;
  }

  /** draft = keep for later · submitted = ask for approval · approved = submit and approve now (approvers). */
  async function save(target: 'draft' | 'submitted' | 'approved') {
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
      vendor: form.vendor.trim() || null,
    };
    setBusy(true);
    setError(null);
    let id = editId;
    if (editId) {
      const { error: upErr } = await supabase.from('expenses').update(row).eq('id', editId);
      if (upErr) return fail(upErr.message);
      const current = expenses.find((x) => x.id === editId);
      if (target !== 'draft' && (current?.status === 'draft' || current?.status === 'rejected')) {
        const { error: subErr } = await supabase.rpc('submit_expense', { p_id: editId });
        if (subErr) return fail(subErr.message);
      }
    } else {
      const { data, error: insErr } = await supabase
        .from('expenses')
        .insert({ ...row, status: target === 'draft' ? 'draft' : 'submitted' })
        .select('id')
        .single();
      if (insErr || !data) return fail(insErr?.message ?? 'Could not save the expense.');
      id = (data as { id: string }).id;
    }
    if (id && receipt) {
      const msg = await uploadReceipt(id, receipt);
      if (msg) return fail(`Saved, but the receipt didn't upload: ${msg}`);
    }
    if (id && target === 'approved') {
      const { error: apErr } = await supabase.rpc('approve_expense', { p_id: id });
      if (apErr) return fail(`Saved and submitted, but not approved: ${apErr.message}`);
    }
    setBusy(false);
    setForm(emptyForm());
    setEditId(null);
    setReceipt(null);
    router.refresh();
  }

  function fail(message: string) {
    setBusy(false);
    setError(message);
  }

  async function remove(id: string) {
    if (!window.confirm('Delete this expense?')) return;
    await run(() => supabase.from('expenses').delete().eq('id', id));
  }

  async function act(fn: string, args: Record<string, unknown>) {
    await run(() => supabase.rpc(fn, args));
  }

  async function rejectOrVoid(ex: Expense, kind: 'reject' | 'void') {
    const reason = window.prompt(
      kind === 'reject' ? 'Why is this expense rejected? (shown to the submitter)' : 'Why is this expense being voided?',
    );
    if (!reason || !reason.trim()) return;
    await act(kind === 'reject' ? 'reject_expense' : 'void_expense', { p_id: ex.id, p_reason: reason.trim() });
  }

  async function confirmPay(e: React.FormEvent) {
    e.preventDefault();
    if (!payFor) return;
    const ok = await run(() =>
      supabase.rpc('pay_expense', {
        p_id: payFor.id,
        p_method: payMethod,
        p_reference: payRef.trim() || null,
        p_paid_on: payDate || null,
      }),
    );
    if (ok) setPayFor(null);
  }

  async function openReceipt(path: string) {
    const { data, error: urlErr } = await supabase.storage.from('expense-receipts').createSignedUrl(path, 300);
    if (urlErr || !data) setError(urlErr?.message ?? 'Could not open the receipt.');
    else window.open(data.signedUrl, '_blank', 'noopener');
  }

  async function attachTo(ex: Expense, file: File | undefined) {
    if (!file) return;
    setBusy(true);
    setError(null);
    const msg = await uploadReceipt(ex.id, file);
    setBusy(false);
    if (msg) setError(msg);
    else router.refresh();
  }

  // Only approved/paid expenses are costs — charts, category mix and the PDF use these.
  const posted = useMemo(() => expenses.filter(isPostedExpense), [expenses]);
  const pending = useMemo(() => {
    const awaiting = expenses.filter((x) => x.status === 'submitted');
    const unpaid = expenses.filter((x) => x.status === 'approved');
    const sum = (xs: Expense[]) => xs.reduce((s, x) => s + x.amount_cents, 0);
    return openSummary ?? { awaiting: awaiting.length, awaitingCents: sum(awaiting), unpaid: unpaid.length, unpaidCents: sum(unpaid) };
  }, [expenses, openSummary]);

  // Filtered expenses list (every status, so drafts and approvals are visible)
  const filtered = useMemo(
    () =>
      expenses.filter(
        (ex) =>
          (!categoryFilter || ex.category === categoryFilter) &&
          (!statusFilter || (ex.status ?? 'paid') === statusFilter),
      )
      .slice()
      .sort((a, b) => {
        const byDate = a.expense_date < b.expense_date ? -1 : a.expense_date > b.expense_date ? 1 : 0;
        switch (sortKey) {
          case 'oldest':
            return byDate;
          case 'amount_desc':
            return b.amount_cents - a.amount_cents || -byDate;
          case 'amount_asc':
            return a.amount_cents - b.amount_cents || -byDate;
          case 'category':
            return a.category.localeCompare(b.category) || -byDate;
          default:
            return -byDate;
        }
      }),
    [expenses, categoryFilter, statusFilter, sortKey],
  );
  // Month headings with each month's total, when sorted by date and the list spans several months.
  const monthTotals = useMemo(() => {
    const m = new Map<string, { count: number; cents: number; postedCents: number }>();
    for (const ex of filtered) {
      const k = ex.expense_date.slice(0, 7);
      const cur = m.get(k) ?? { count: 0, cents: 0, postedCents: 0 };
      cur.count += 1;
      cur.cents += ex.amount_cents;
      if (isPostedExpense(ex)) cur.postedCents += ex.amount_cents;
      m.set(k, cur);
    }
    return m;
  }, [filtered]);
  const groupByMonth = (sortKey === 'newest' || sortKey === 'oldest') && monthTotals.size > 1;
  const filteredTotal = useMemo(() => filtered.reduce((s, ex) => s + ex.amount_cents, 0), [filtered]);
  const categoriesInUse = useMemo(
    () => Array.from(new Set(expenses.map((ex) => ex.category))).sort(),
    [expenses],
  );

  // Daily expenses aggregated with date normalization
  const expensesByDate = useMemo(() => {
    const map = new Map<string, number>();
    for (const ex of posted) {
      const k = normalizeDateStr(ex.expense_date);
      if (k) map.set(k, (map.get(k) ?? 0) + ex.amount_cents);
    }
    return map;
  }, [posted]);

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

  // Expense breakdown by category (scoped to active period for consistency with P&L)
  const categoryTotals = useMemo(() => {
    const map = new Map<string, number>();
    for (const ex of posted) {
      const k = normalizeDateStr(ex.expense_date);
      if (fromStr && k && k < fromStr) continue;
      if (toStr && k && k > toStr) continue;
      map.set(ex.category, (map.get(ex.category) ?? 0) + ex.amount_cents);
    }
    const total = Array.from(map.values()).reduce((a, b) => a + b, 0);
    return CATEGORIES.map((cat) => {
      const cents = map.get(cat) ?? 0;
      const p = total > 0 ? (cents / total) * 100 : 0;
      return { category: cat, cents, pct: Math.round(p * 10) / 10 };
    }).filter((c) => c.cents > 0);
  }, [posted, fromStr, toStr]);

  const totalExpensesCents = useMemo(
    () => categoryTotals.reduce((s, c) => s + c.cents, 0),
    [categoryTotals],
  );

  return (
    <div className="space-y-8">
      {error && (
        <div className="rounded border border-danger/40 bg-danger/10 text-danger p-3 text-xs">{error}</div>
      )}

      {/* Period */}
      <div className="flex flex-wrap items-center justify-between gap-4 p-4 rounded-xl border border-border bg-main/40">
        {periodBar}

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
                hint={`${posted.length} approved / paid`}
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
            {!isMounted ? (
              <div className="h-full w-full rounded-lg bg-main/30 border border-border/40 animate-pulse flex items-center justify-center text-xs text-muted">
                Loading analytics…
              </div>
            ) : (
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
                    tickFormatter={(v) => axisMoney(v)}
                  />
                  <ReferenceLine y={0} stroke="rgba(255,255,255,0.25)" strokeDasharray="3 3" />
                  <Tooltip
                    cursor={{ fill: 'rgba(255,255,255,0.04)', stroke: 'rgba(255,255,255,0.15)', strokeDasharray: '3 3' }}
                    content={({ active, payload, label }) => {
                      if (!active || !payload || payload.length === 0) return null;
                      const d = payload[0]?.payload;
                      if (!d) return null;
                      const isProfitPositive = (chartMode === 'daily' ? d.netProfit : d.cumNetProfit) >= 0;
                      return (
                        <div className="rounded-lg border border-border bg-surface p-3 shadow-xl text-xs space-y-1">
                          <div className="font-bold text-body border-b border-border pb-1">
                            {d.fullDate || label}
                          </div>
                          <div className="flex justify-between gap-4 text-ok">
                            <span>Net Sales:</span>
                            <span className="font-mono font-bold">
                              ${(chartMode === 'daily' ? d.netSales : d.cumNetSales).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                            </span>
                          </div>
                          <div className="flex justify-between gap-4 text-danger">
                            <span>Expenses:</span>
                            <span className="font-mono font-bold">
                              ${(chartMode === 'daily' ? d.expenses : d.cumExpenses).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                            </span>
                          </div>
                          <div className={`flex justify-between gap-4 pt-1 border-t border-border font-bold ${isProfitPositive ? 'text-ok' : 'text-danger'}`}>
                            <span>Net Profit:</span>
                            <span className="font-mono">
                              ${(chartMode === 'daily' ? d.netProfit : d.cumNetProfit).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                            </span>
                          </div>
                        </div>
                      );
                    }}
                  />
                  {chartMode === 'daily' ? (
                    <>
                      <Bar
                        dataKey="netSales"
                        name="Net Sales"
                        fill="#10b981"
                        radius={[3, 3, 0, 0]}
                        maxBarSize={22}
                        isAnimationActive={false}
                      />
                      <Bar
                        dataKey="expenses"
                        name="Operating Expenses"
                        fill="#f43f5e"
                        radius={[3, 3, 0, 0]}
                        maxBarSize={22}
                        isAnimationActive={false}
                      />
                      <Line
                        type="linear"
                        dataKey="netProfit"
                        name="Net Profit"
                        stroke="#818cf8"
                        strokeWidth={2.5}
                        dot={{ r: 3, fill: '#818cf8', stroke: '#1e1b4b', strokeWidth: 1.5 }}
                        activeDot={{ r: 6 }}
                        isAnimationActive={false}
                      />
                    </>
                  ) : (
                    <>
                      <Area
                        type="linear"
                        dataKey="cumNetSales"
                        name="Cumulative Sales"
                        stroke="#10b981"
                        strokeWidth={2}
                        fillOpacity={0.25}
                        fill="url(#salesGrad)"
                        isAnimationActive={false}
                        dot={{ r: 2, fill: '#10b981' }}
                      />
                      <Area
                        type="linear"
                        dataKey="cumExpenses"
                        name="Cumulative Expenses"
                        stroke="#f43f5e"
                        strokeWidth={2}
                        fillOpacity={0.25}
                        fill="url(#expenseGrad)"
                        isAnimationActive={false}
                        dot={{ r: 2, fill: '#f43f5e' }}
                      />
                      <Line
                        type="linear"
                        dataKey="cumNetProfit"
                        name="Cumulative Profit"
                        stroke="#818cf8"
                        strokeWidth={2.5}
                        dot={{ r: 2.5, fill: '#818cf8' }}
                        activeDot={{ r: 6 }}
                        isAnimationActive={false}
                      />
                    </>
                  )}
                </ComposedChart>
              </ResponsiveContainer>
            )}
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
              <span className="inline-block w-3 h-3 rounded-full bg-[#818cf8]" />
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

      {(pending.awaiting > 0 || pending.unpaid > 0) && (
        <div className="flex flex-wrap gap-2 text-xs">
          {pending.awaiting > 0 && (
            <button
              type="button"
              onClick={() => setStatusFilter('submitted')}
              className="rounded-lg border border-warn/40 bg-warn/10 px-3 py-2 text-left"
            >
              <span className="font-bold text-warn">{pending.awaiting} awaiting approval</span>
              <span className="text-muted"> · {formatCents(pending.awaitingCents)} — not in profit yet</span>
            </button>
          )}
          {pending.unpaid > 0 && (
            <button
              type="button"
              onClick={() => setStatusFilter('approved')}
              className="rounded-lg border border-primary/40 bg-primary/10 px-3 py-2 text-left"
            >
              <span className="font-bold text-primary">{pending.unpaid} approved, not yet paid</span>
              <span className="text-muted"> · {formatCents(pending.unpaidCents)}</span>
            </button>
          )}
        </div>
      )}

      {canWrite && (
        <Card>
          <h2 className="font-bold mb-1 text-sm">{editId ? 'Edit expense' : 'Add expense'}</h2>
          <p className="text-[11px] text-muted mb-3">
            An expense counts toward profit once it is approved. Save a draft to finish later, or submit it for approval.
          </p>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void save('submitted');
            }}
            className="grid grid-cols-1 sm:grid-cols-6 gap-3 items-end"
          >
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
            <Field label="Paid to (vendor)">
              <Input value={form.vendor} onChange={(e) => set('vendor', e.target.value)} placeholder="optional" />
            </Field>
            <Field label="Receipt">
              <input
                type="file"
                accept="application/pdf,image/jpeg,image/png,image/webp,image/heic"
                onChange={(e) => setReceipt(e.target.files?.[0] ?? null)}
                className="block w-full text-[11px] text-muted file:mr-2 file:rounded file:border-0 file:bg-main file:px-2 file:py-1 file:text-xs"
              />
            </Field>
            <div className="flex flex-wrap gap-2 sm:col-span-4">
              <Button type="submit" disabled={busy}>
                {editId ? 'Save & submit' : 'Submit for approval'}
              </Button>
              {canApprove && (
                <Button type="button" variant="ghost" disabled={busy} onClick={() => void save('approved')}>
                  {editId ? 'Save & approve' : 'Add as approved'}
                </Button>
              )}
              <Button type="button" variant="ghost" disabled={busy} onClick={() => void save('draft')}>
                Save draft
              </Button>
              {editId && (
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => {
                    setEditId(null);
                    setReceipt(null);
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

      {payFor && (
        <Card className="border-primary/40">
          <h2 className="font-bold text-sm mb-1">
            Mark paid · {payFor.category} {formatCents(payFor.amount_cents)}
          </h2>
          <p className="text-[11px] text-muted mb-3">{payFor.description ?? payFor.vendor ?? payFor.expense_date}</p>
          <form onSubmit={confirmPay} className="grid grid-cols-1 sm:grid-cols-4 gap-3 items-end">
            <Field label="Paid by">
              <Select value={payMethod} onChange={(e) => setPayMethod(e.target.value)}>
                {PAYMENT_METHODS.map((m) => (
                  <option key={m.value} value={m.value}>
                    {m.label}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Reference">
              <Input value={payRef} onChange={(e) => setPayRef(e.target.value)} placeholder="transfer / cheque no." />
            </Field>
            <Field label="Paid on">
              <Input type="date" value={payDate} onChange={(e) => setPayDate(e.target.value)} />
            </Field>
            <div className="flex gap-2">
              <Button type="submit" disabled={busy}>
                Confirm payment
              </Button>
              <Button type="button" variant="ghost" onClick={() => setPayFor(null)}>
                Cancel
              </Button>
            </div>
          </form>
        </Card>
      )}

      <section>
        <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
          <h2 className="font-bold text-sm">All Recorded Expenses</h2>
          <div className="flex items-center gap-2 text-xs">
            <span className="text-muted">Sort:</span>
            <select
              id="expense-sort"
              value={sortKey}
              onChange={(e) => setSortKey(e.target.value as typeof sortKey)}
              className="rounded-md border border-border bg-surface px-2 py-1.5 text-xs"
            >
              <option value="newest">Date: newest first</option>
              <option value="oldest">Date: oldest first</option>
              <option value="amount_desc">Amount: high to low</option>
              <option value="amount_asc">Amount: low to high</option>
              <option value="category">Category A–Z</option>
            </select>
            <span className="text-muted">Filter:</span>
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value as '' | ExpenseStatus)}
              className="rounded-md border border-border bg-surface px-2 py-1.5 text-xs"
            >
              <option value="">All statuses</option>
              {(Object.keys(STATUS_LABEL) as ExpenseStatus[]).map((s) => (
                <option key={s} value={s}>
                  {STATUS_LABEL[s]}
                </option>
              ))}
            </select>
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
                  <th className="p-3 font-semibold">Status</th>
                  <th className="p-3 font-semibold text-right">Amount</th>
                  <th className="p-3" />
                </tr>
              </thead>
              <tbody>
                {filtered.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="p-3 text-muted">
                      {expenses.length === 0 ? 'No expenses recorded yet.' : 'No expenses match these filters.'}
                    </td>
                  </tr>
                ) : (
                  filtered.map((ex, i) => {
                    const st: ExpenseStatus = ex.status ?? 'paid';
                    const editable = st === 'draft' || st === 'submitted' || st === 'rejected';
                    const ym = ex.expense_date.slice(0, 7);
                    const mt = monthTotals.get(ym);
                    const newMonth = groupByMonth && (i === 0 || filtered[i - 1].expense_date.slice(0, 7) !== ym);
                    return (
                      <Fragment key={ex.id}>
                      {newMonth && mt && (
                        <tr className="bg-main/60 border-b border-border">
                          <td colSpan={4} className="p-2.5 font-bold">
                            {monthLabel(ym)} <span className="font-normal text-muted">· {mt.count} expense{mt.count === 1 ? '' : 's'}</span>
                          </td>
                          <td className="p-2.5 text-right font-mono font-bold">{formatCents(mt.postedCents)}</td>
                          <td className="p-2.5 text-[10px] text-muted">approved / paid{mt.cents !== mt.postedCents ? ` · ${formatCents(mt.cents)} incl. pending` : ''}</td>
                        </tr>
                      )}
                      <tr className="border-b border-border/60 last:border-0 align-top">
                        <td className="p-3 text-muted whitespace-nowrap">{ex.expense_date}</td>
                        <td className="p-3 font-semibold">{ex.category}</td>
                        <td className="p-3 text-muted">
                          {ex.description ?? '—'}
                          {ex.vendor && <span className="text-[10px] ml-1.5">· {ex.vendor}</span>}
                          {ex.supplier_id && (
                            <span className="text-primary text-[10px] font-semibold ml-1.5">
                              · {suppliers.find((s) => s.id === ex.supplier_id)?.name ?? 'supplier'}
                            </span>
                          )}
                          {ex.attachment_path && (
                            <button
                              type="button"
                              onClick={() => void openReceipt(ex.attachment_path!)}
                              className="ml-1.5 text-[10px] font-semibold text-primary underline"
                            >
                              receipt
                            </button>
                          )}
                          {st === 'rejected' && ex.rejection_reason && (
                            <div className="text-[10px] text-danger mt-0.5">Rejected: {ex.rejection_reason}</div>
                          )}
                          {st === 'void' && ex.void_reason && (
                            <div className="text-[10px] mt-0.5">Voided: {ex.void_reason}</div>
                          )}
                          {st === 'paid' && ex.payment_method && (
                            <div className="text-[10px] mt-0.5">
                              Paid by {PAYMENT_METHODS.find((m) => m.value === ex.payment_method)?.label ?? ex.payment_method}
                              {ex.payment_reference ? ` · ref ${ex.payment_reference}` : ''}
                            </div>
                          )}
                        </td>
                        <td className="p-3 whitespace-nowrap">
                          <span className={`rounded px-1.5 py-0.5 text-[10px] font-bold ${STATUS_TONE[st]}`}>{STATUS_LABEL[st]}</span>
                        </td>
                        <td className={`p-3 text-right font-mono ${isPostedExpense(ex) ? '' : 'text-muted'}`}>
                          {formatCents(ex.amount_cents)}
                        </td>
                        <td className="p-3 text-right whitespace-nowrap space-x-1">
                          {canWrite && (st === 'draft' || st === 'rejected') && (
                            <Button variant="ghost" disabled={busy} onClick={() => void act('submit_expense', { p_id: ex.id })}>
                              Submit
                            </Button>
                          )}
                          {canApprove && st === 'submitted' && (
                            <Button disabled={busy} onClick={() => void act('approve_expense', { p_id: ex.id })}>
                              Approve
                            </Button>
                          )}
                          {canApprove && (st === 'submitted' || st === 'approved') && (
                            <Button variant="ghost" disabled={busy} onClick={() => void rejectOrVoid(ex, 'reject')}>
                              Reject
                            </Button>
                          )}
                          {canPay && st === 'approved' && (
                            <Button
                              disabled={busy}
                              onClick={() => {
                                setPayFor(ex);
                                setPayRef('');
                                setPayDate(todayLocal());
                              }}
                            >
                              Mark paid
                            </Button>
                          )}
                          {canApprove && (st === 'approved' || st === 'paid') && (
                            <Button variant="ghost" disabled={busy} onClick={() => void rejectOrVoid(ex, 'void')}>
                              Void
                            </Button>
                          )}
                          {canWrite && st !== 'void' && !ex.attachment_path && (
                            <label className="inline-block cursor-pointer text-[11px] font-semibold text-primary px-1.5">
                              Attach receipt
                              <input
                                type="file"
                                className="hidden"
                                accept="application/pdf,image/jpeg,image/png,image/webp,image/heic"
                                onChange={(e) => void attachTo(ex, e.target.files?.[0])}
                              />
                            </label>
                          )}
                          {canWrite && editable && (
                            <Button variant="ghost" disabled={busy} onClick={() => startEdit(ex)}>
                              Edit
                            </Button>
                          )}
                          {canDelete && editable && (
                            <Button variant="danger" disabled={busy} onClick={() => remove(ex.id)}>
                              Delete
                            </Button>
                          )}
                        </td>
                      </tr>
                      </Fragment>
                    );
                  })
                )}
              </tbody>
              {filtered.length > 0 && (
                <tfoot>
                  <tr className="border-t border-border bg-main/60">
                    <td className="p-3 font-semibold" colSpan={4}>
                      {[statusFilter && STATUS_LABEL[statusFilter], categoryFilter].filter(Boolean).join(' · ') || 'Total'} (
                      {filtered.length})
                    </td>
                    <td className="p-3 text-right font-mono font-bold">{formatCents(filteredTotal)}</td>
                    <td className="p-3" />
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
