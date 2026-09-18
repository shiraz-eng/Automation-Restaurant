'use client';

import { useEffect, useMemo, useState } from 'react';
import { usePortalSupabase } from '@/components/PortalProvider';
import { formatCents } from '@/lib/format';
import { saveAndStoreReportPdf } from '@/lib/generateReport';
import { ProfitDrilldownModal } from '@/components/ProfitDrilldown';
import type {
  ReportPurchasing,
  ReportSupplierPayable,
  ReportManagementActivity,
  ReportAttentionItem,
  ReportDeal,
  ReportPromotion,
  ReportInventory,
  ReportAiInsights,
} from '@/lib/generateReport';

const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  PieChart,
  Pie,
  Cell,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  type TooltipProps,
} from 'recharts';

// last_3_months/last_6_months/last_year mirror the same additions made to
// the API's own Period (apps/api/src/lib/aiTools.ts) for the Restaurant
// Performance & Owner Activity Intelligence tools (spec §1) — the
// dashboard's charts now offer the same range the AI chat/PDF/Excel export
// already support.
// 'this_year' is deliberately NOT in PERIODS below (which drives the
// Dashboard's own visible buttons — left untouched) — it exists on the
// type/periodRange() so the new per-section report pages (Suppliers,
// Purchasing, Inventory, Orders, Expenses), which define their own period
// button list, can offer a calendar-year option without changing the
// Dashboard.
export type Period = 'today' | 'yesterday' | 'this_week' | 'last_week' | 'this_month' | 'last_month' | 'last_3_months' | 'last_6_months' | 'this_year' | 'last_year';
const PERIODS: { key: Period; label: string }[] = [
  { key: 'today', label: 'Today' },
  { key: 'yesterday', label: 'Yesterday' },
  { key: 'this_week', label: 'This week' },
  { key: 'last_week', label: 'Last week' },
  { key: 'this_month', label: 'This month' },
  { key: 'last_month', label: 'Last month' },
  { key: 'last_3_months', label: '3 months' },
  { key: 'last_6_months', label: '6 months' },
  { key: 'last_year', label: '1 year' },
];
const PERIOD_LABEL: Record<Period, string> = Object.fromEntries(PERIODS.map((p) => [p.key, p.label])) as Record<Period, string>;

// Mirrors EXCEL_OPTIONAL_SHEETS (apps/api/src/lib/excelExport.ts) — the
// Custom Export domain picker (spec §37). Executive Summary, Profit
// Summary and Verification are always included server-side regardless of
// selection, so they aren't offered as checkboxes here.
const EXCEL_OPTIONAL_SHEETS = [
  'Daily Performance', 'Orders', 'Product Profitability', 'Deal Profitability', 'Promotions',
  'Purchasing', 'Accounts Payable', 'Supplier Payments', 'Supplier Performance', 'Inventory',
  'Expenses', 'Management Activity', 'AI Actions',
] as const;

export function periodRange(period: Period) {
  const startOfDay = (d: Date) => {
    const x = new Date(d);
    x.setHours(0, 0, 0, 0);
    return x;
  };
  const addDays = (d: Date, n: number) => new Date(d.getTime() + n * 86400_000);
  const today0 = startOfDay(new Date());
  const now = new Date();
  switch (period) {
    case 'yesterday': {
      const from = addDays(today0, -1);
      return { from, to: today0, prevFrom: addDays(from, -1), prevTo: from };
    }
    case 'this_week': {
      const dow = (today0.getDay() + 6) % 7;
      const from = addDays(today0, -dow);
      return { from, to: addDays(today0, 1), prevFrom: addDays(from, -7), prevTo: from };
    }
    case 'last_week': {
      const dow = (today0.getDay() + 6) % 7;
      const thisWeekFrom = addDays(today0, -dow);
      const from = addDays(thisWeekFrom, -7);
      return { from, to: thisWeekFrom, prevFrom: addDays(from, -7), prevTo: from };
    }
    case 'this_month': {
      const from = new Date(now.getFullYear(), now.getMonth(), 1);
      const prevFrom = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      return { from, to: addDays(today0, 1), prevFrom, prevTo: from };
    }
    case 'last_month': {
      const from = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const to = new Date(now.getFullYear(), now.getMonth(), 1);
      return { from, to, prevFrom: new Date(now.getFullYear(), now.getMonth() - 2, 1), prevTo: from };
    }
    case 'last_3_months': {
      const from = new Date(now.getFullYear(), now.getMonth() - 3, 1);
      const prevFrom = new Date(now.getFullYear(), now.getMonth() - 6, 1);
      return { from, to: addDays(today0, 1), prevFrom, prevTo: from };
    }
    case 'last_6_months': {
      const from = new Date(now.getFullYear(), now.getMonth() - 6, 1);
      const prevFrom = new Date(now.getFullYear(), now.getMonth() - 12, 1);
      return { from, to: addDays(today0, 1), prevFrom, prevTo: from };
    }
    case 'this_year': {
      const from = new Date(now.getFullYear(), 0, 1);
      const prevFrom = new Date(now.getFullYear() - 1, 0, 1);
      return { from, to: addDays(today0, 1), prevFrom, prevTo: from };
    }
    case 'last_year': {
      const from = new Date(now.getFullYear() - 1, now.getMonth(), now.getDate());
      const prevFrom = new Date(now.getFullYear() - 2, now.getMonth(), now.getDate());
      return { from, to: addDays(today0, 1), prevFrom, prevTo: from };
    }
    default: {
      const from = today0;
      return { from, to: addDays(today0, 1), prevFrom: addDays(from, -1), prevTo: from };
    }
  }
}
const asDate = (d: Date) => d.toISOString().slice(0, 10);

export type CustomRange = { from: string; to: string };
/** An owner-chosen date range from the two <input type="date"> fields
 *  below (spec §1's "Custom Period") — mirrors the API's own
 *  customRange() (apps/api/src/lib/aiTools.ts) exactly, including the
 *  previous-period comparison window being the immediately preceding
 *  range of the SAME length, so % changes stay meaningful. Built from
 *  local Y-M-D date-input values throughout (no toISOString() on a
 *  shifted boundary) — the API side found and fixed a timezone bug from
 *  exactly that pattern; this mirrors the fixed version, not the original. */
function resolveRange(period: Period, custom: CustomRange | null): { from: Date; to: Date; prevFrom: Date; prevTo: Date } {
  if (custom && custom.from && custom.to) {
    const from = new Date(`${custom.from}T00:00:00`);
    const toInclusive = new Date(`${custom.to}T00:00:00`);
    const to = new Date(toInclusive.getTime() + 86400_000);
    const spanMs = Math.max(to.getTime() - from.getTime(), 86400_000);
    return { from, to, prevFrom: new Date(from.getTime() - spanMs), prevTo: from };
  }
  return periodRange(period);
}
function customRangeLabel(custom: CustomRange): string {
  const fmt = (s: string) => new Date(`${s}T00:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  return `${fmt(custom.from)} - ${fmt(custom.to)}`;
}

type DaySum = { net_sales_cents: number; orders_count: number };
// Full period_profitability() row — widened from the old {gross_profit_cents,
// food_cost_pct} shape so Net Profit (already computed by that RPC, just
// never rendered here) can reach the dashboard's own KPI row instead of
// living only on the separate /finance page and inside AI chat answers.
type Profitability = {
  gross_sales_cents: number;
  discount_cents: number;
  refunded_cents: number;
  net_sales_cents: number;
  theoretical_cogs_cents: number;
  cogs_lines_total: number;
  cogs_lines_missing: number;
  gross_profit_cents: number;
  gross_margin_pct: number | null;
  food_cost_pct: number | null;
  actual_cogs_cents: number;
  cogs_variance_cents: number;
  expenses_cents: number;
  net_profit_cents: number;
  net_profit_margin_pct: number | null;
} | null;
type Slice = { name: string; value: number };
type ItemRow = {
  name: string;
  qty_sold: number;
  revenue_cents: number;
  cogs_cents: number;
  contribution_cents: number;
  contribution_margin_pct: number | null;
};
type AttendanceRow = { membership_id: string; full_name: string | null; role: string; status: string; late_minutes: number };
type FeedbackRow = {
  responses: number;
  avg_overall: number | null;
  avg_food: number | null;
  avg_service: number | null;
  avg_cleanliness: number | null;
  avg_speed: number | null;
  avg_ambiance: number | null;
};

const PIE_COLORS = ['rgb(var(--primary))', 'rgb(var(--ok))', 'rgb(var(--warn))', 'rgb(var(--danger))', 'rgb(var(--text-muted))'];

const ATTENDANCE_DOT: Record<string, string> = {
  present: 'bg-ok',
  late: 'bg-warn',
  early_departure: 'bg-warn',
  incomplete: 'bg-warn',
  absent: 'bg-danger',
  leave: 'bg-primary',
  not_marked: 'bg-border',
};

function PieTooltip({ active, payload }: TooltipProps<number, string>) {
  if (!active || !payload || !payload[0]) return null;
  const p = payload[0];
  return (
    <div className="rounded border border-border bg-surface px-3 py-1.5 text-[11px] shadow-lg">
      <span className="font-bold text-body">{p.name}</span>
      <span className="text-muted ml-2 font-mono">{formatCents(Number(p.value) * 100)}</span>
    </div>
  );
}

function Delta({ curr, prev }: { curr: number; prev: number }) {
  if (prev === 0) return null;
  const pct = Math.round(((curr - prev) / prev) * 1000) / 10;
  if (pct === 0) return <span className="text-muted text-[11px]">flat vs previous period</span>;
  const up = pct > 0;
  return (
    <span className={`text-[11px] font-semibold ${up ? 'text-ok' : 'text-danger'}`}>
      {up ? '↑' : '↓'} {Math.abs(pct)}% <span className="text-muted font-normal">vs previous period</span>
    </span>
  );
}

function Kpi({ label, value, delta, tone, onClick }: { label: string; value: string; delta?: React.ReactNode; tone?: 'ok' | 'danger'; onClick?: () => void }) {
  const Tag = onClick ? 'button' : 'div';
  return (
    <Tag
      onClick={onClick}
      className={`rounded-lg border border-border bg-surface p-4 text-left w-full ${onClick ? 'hover:border-primary/50 cursor-pointer' : ''}`}
    >
      <div className="text-muted text-[11px] font-semibold flex items-center gap-1">
        {label}
        {onClick && <span className="text-primary">↴</span>}
      </div>
      <div className={`mt-1 text-xl font-black tabular-nums transition-all ${tone === 'ok' ? 'text-ok' : tone === 'danger' ? 'text-danger' : ''}`}>{value}</div>
      {delta && <div className="mt-1">{delta}</div>}
    </Tag>
  );
}

/**
 * Restaurant Performance: a period selector (spec §29) driving a KPI row
 * with period-over-period change (§16), revenue/payment mix pies (§10),
 * top products (§11), today's attendance (§13) and customer experience
 * (§12). Every number here comes from an authoritative RPC — sales_by_day
 * for net sales/orders (same population as the trend chart above),
 * period_profitability for gross profit/food cost (silently omitted for a
 * role without finance permission — the backend enforces this, not a
 * frontend hide), and the existing attendance/feedback systems.
 */
export function PerformancePanel({
  slug,
  restaurantName,
  period,
  onPeriodChange,
  customRange,
  onCustomRangeChange,
  aiSummary,
}: {
  slug: string;
  restaurantName: string;
  period: Period;
  onPeriodChange: (p: Period) => void;
  customRange: CustomRange | null;
  onCustomRangeChange: (r: CustomRange | null) => void;
  aiSummary?: string | null;
}) {
  const supabase = usePortalSupabase();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [customDraft, setCustomDraft] = useState<CustomRange>(customRange ?? { from: '', to: '' });
  const [customOpen, setCustomOpen] = useState(false);
  const periodLabel = customRange ? customRangeLabel(customRange) : PERIOD_LABEL[period];
  // null = full workbook (every sheet); a Set here means "only these
  // optional sheets" — the Custom Export domain picker (spec §37).
  const [sheetPickerOpen, setSheetPickerOpen] = useState(false);
  const [selectedSheets, setSelectedSheets] = useState<Set<string> | null>(null);

  const [sales, setSales] = useState<DaySum | null>(null);
  const [prevSales, setPrevSales] = useState<DaySum | null>(null);
  const [profit, setProfit] = useState<Profitability>(null);
  const [prevProfit, setPrevProfit] = useState<Profitability>(null);
  const [canSeeProfit, setCanSeeProfit] = useState(true);
  const [categoryMix, setCategoryMix] = useState<Slice[]>([]);
  const [paymentMixData, setPaymentMixData] = useState<Slice[]>([]);
  const [topItems, setTopItems] = useState<ItemRow[]>([]);
  const [topSort, setTopSort] = useState<'revenue_cents' | 'qty_sold'>('revenue_cents');
  const [feedback, setFeedback] = useState<FeedbackRow | null>(null);
  const [attendance, setAttendance] = useState<AttendanceRow[] | null>(null);
  const [dailyRows, setDailyRows] = useState<{ business_date: string; net_sales_cents: number }[]>([]);
  const [verifyOpen, setVerifyOpen] = useState(false);
  const [drilldownLevel, setDrilldownLevel] = useState<'net_profit' | 'gross_profit' | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    const { from, to, prevFrom, prevTo } = resolveRange(period, customRange);

    async function fetchDays(from: Date, to: Date) {
      const { data, error: err } = await supabase.rpc('sales_by_day', { p_from: asDate(from), p_to: asDate(to) });
      if (err) throw err;
      return (data as { business_date: string; net_sales_cents: number; orders_count: number }[]) ?? [];
    }
    async function sumDays(from: Date, to: Date): Promise<DaySum & { rows: { business_date: string; net_sales_cents: number }[] }> {
      const rows = await fetchDays(from, to);
      return {
        net_sales_cents: rows.reduce((s, r) => s + r.net_sales_cents, 0),
        orders_count: rows.reduce((s, r) => s + r.orders_count, 0),
        rows: rows.map((r) => ({ business_date: r.business_date, net_sales_cents: r.net_sales_cents })),
      };
    }

    (async () => {
      try {
        const [curr, prev] = await Promise.all([sumDays(from, to), sumDays(prevFrom, prevTo)]);
        if (cancelled) return;
        setSales(curr);
        setPrevSales(prev);
        setDailyRows(curr.rows);

        const profitRes = await supabase.rpc('period_profitability', { p_from: from.toISOString(), p_to: to.toISOString() });
        if (profitRes.error) {
          setCanSeeProfit(false);
          setProfit(null);
        } else {
          setCanSeeProfit(true);
          const row = (profitRes.data as Profitability[] | null)?.[0] ?? null;
          setProfit(row);
          const prevProfitRes = await supabase.rpc('period_profitability', {
            p_from: prevFrom.toISOString(),
            p_to: prevTo.toISOString(),
          });
          setPrevProfit((prevProfitRes.data as Profitability[] | null)?.[0] ?? null);
        }

        const [catRes, payRes, itemRes, fbRes] = await Promise.all([
          supabase.rpc('revenue_by_category', { p_from: from.toISOString(), p_to: to.toISOString() }),
          supabase.rpc('payment_mix', { p_from: from.toISOString(), p_to: to.toISOString() }),
          supabase.rpc('item_profitability', { p_from: from.toISOString(), p_to: to.toISOString() }),
          supabase.rpc('feedback_summary', { p_from: from.toISOString(), p_to: to.toISOString() }),
        ]);
        if (cancelled) return;
        if (catRes.error) throw catRes.error;
        if (payRes.error) throw payRes.error;
        // item_profitability requires finance.view_profit/finance.view_cogs/
        // inventory.view_cost (same cost-visibility gate as period_profitability
        // above) — degrades the same way that already does (an empty Top
        // Products list) rather than throwing and blanking the whole panel
        // for a caller who simply isn't granted cost visibility.
        if (fbRes.error) throw fbRes.error;

        setCategoryMix(
          ((catRes.data as { category_name: string; revenue_cents: number }[]) ?? []).map((r) => ({
            name: r.category_name,
            value: r.revenue_cents / 100,
          })),
        );
        setPaymentMixData(
          ((payRes.data as { method: string; revenue_cents: number }[]) ?? []).map((r) => ({
            name: r.method,
            value: r.revenue_cents / 100,
          })),
        );
        setTopItems(itemRes.error ? [] : ((itemRes.data as ItemRow[]) ?? []).slice(0, 8));
        setFeedback((fbRes.data as FeedbackRow[] | null)?.[0] ?? null);
      } catch (e) {
        // Supabase RPC errors are plain {message, code, ...} objects, not
        // Error instances — String(e) on one of those prints "[object
        // Object]" rather than anything useful.
        if (!cancelled) {
          const message =
            e instanceof Error
              ? e.message
              : typeof e === 'object' && e !== null && 'message' in e
                ? String((e as { message: unknown }).message)
                : String(e);
          setError(message);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [period, customRange, supabase]);

  // Today's attendance is always "today", independent of the period picker
  // (spec §13's own framing) — fetched once.
  useEffect(() => {
    let cancelled = false;
    supabase.rpc('attendance_roster', {}).then(({ data, error: err }) => {
      if (cancelled || err) return;
      setAttendance((data as AttendanceRow[]) ?? []);
    });
    return () => {
      cancelled = true;
    };
  }, [supabase]);

  const aov = sales && sales.orders_count > 0 ? Math.round(sales.net_sales_cents / sales.orders_count) : 0;
  const prevAov = prevSales && prevSales.orders_count > 0 ? Math.round(prevSales.net_sales_cents / prevSales.orders_count) : 0;

  const topItemsSorted = useMemo(
    () => topItems.slice().sort((a, b) => b[topSort] - a[topSort]),
    [topItems, topSort],
  );
  const topChartData = topItemsSorted.map((i) => ({
    name: i.name.length > 16 ? `${i.name.slice(0, 15)}…` : i.name,
    fullName: i.name,
    value: topSort === 'revenue_cents' ? i.revenue_cents / 100 : i.qty_sold,
  }));

  async function handleGenerateReport() {
    // Expense records aren't otherwise fetched by this panel (only their
    // period_profitability total is) — pulled fresh here, only when
    // actually generating a report, rather than on every page load.
    let expenseRecords: { category: string; description: string | null; amount_cents: number; expense_date: string }[] | undefined;
    if (canSeeProfit && profit) {
      const { from, to } = resolveRange(period, customRange);
      const { data } = await supabase
        .from('expenses')
        .select('category, description, amount_cents, expense_date')
        .gte('expense_date', from.toISOString().slice(0, 10))
        .lte('expense_date', to.toISOString().slice(0, 10));
      expenseRecords = data ?? [];
    }

    // Restaurant Performance & Owner Activity Intelligence sections (spec
    // §28) — reused from the exact same generate_report action/buildReportData
    // the AI chat's own "generate my report" command already produces,
    // rather than a second, client-side reimplementation of purchasing/
    // payables/management-activity aggregation. This panel keeps its own
    // existing state (kpis/profitDetail/topProducts/categoryMix/paymentMix/
    // feedback/attendance) for everything it already renders on screen —
    // only these four new sections come from the server call below.
    let purchasing: ReportPurchasing | undefined;
    let supplierPayable: ReportSupplierPayable | undefined;
    let managementActivity: ReportManagementActivity | undefined;
    let attentionItems: ReportAttentionItem[] | undefined;
    let deals: ReportDeal[] | undefined;
    let promotions: ReportPromotion[] | undefined;
    let inventoryReconciliation: ReportInventory | undefined;
    let aiInsights: ReportAiInsights | undefined;
    let auditId: string | null = null;
    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      const res = await fetch(`${API}/api/ai/confirm`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session?.access_token ?? ''}` },
        body: JSON.stringify({ slug, name: 'generate_report', args: customRange ? { from: customRange.from, to: customRange.to } : { period } }),
      });
      const body = await res.json().catch(() => ({}));
      if (res.ok && body.result) {
        purchasing = body.result.purchasing ?? undefined;
        supplierPayable = body.result.supplierPayable ?? undefined;
        managementActivity = body.result.managementActivity ?? undefined;
        attentionItems = body.result.attentionItems ?? undefined;
        deals = body.result.deals ?? undefined;
        promotions = body.result.promotions ?? undefined;
        inventoryReconciliation = body.result.inventoryReconciliation ?? undefined;
        aiInsights = body.result.aiInsights ?? undefined;
        auditId = body.auditId ?? null;
      }
    } catch {
      // Non-fatal — the PDF still generates with every section this panel
      // already had locally, just without the intelligence sections.
    }

    await saveAndStoreReportPdf({
      restaurantName,
      periodLabel,
      kpis: {
        net_sales_cents: sales?.net_sales_cents ?? 0,
        orders_count: sales?.orders_count ?? 0,
        aov_cents: aov,
        gross_profit_cents: canSeeProfit && profit ? profit.gross_profit_cents : null,
        food_cost_pct: canSeeProfit && profit ? profit.food_cost_pct : null,
        avg_rating: feedback?.avg_overall ?? null,
      },
      profitDetail: canSeeProfit && profit ? profit : null,
      dailySales: dailyRows,
      topProducts: topItemsSorted.map((i) => ({
        name: i.name,
        qty_sold: i.qty_sold,
        revenue_cents: i.revenue_cents,
        cogs_cents: i.cogs_cents,
        contribution_cents: i.contribution_cents,
        contribution_margin_pct: i.contribution_margin_pct,
      })),
      expenseRecords,
      categoryMix: categoryMix.map((c) => ({ name: c.name, revenue_cents: Math.round(c.value * 100) })),
      paymentMix: paymentMixData.map((c) => ({ name: c.name, revenue_cents: Math.round(c.value * 100) })),
      feedback,
      attendance: attendance ? attendance.map((a) => ({ full_name: a.full_name, status: a.status })) : null,
      purchasing,
      supplierPayable,
      managementActivity,
      attentionItems,
      deals,
      promotions,
      inventoryReconciliation,
      aiInsights,
      aiSummary: aiSummary ?? null,
    }, undefined, { supabase, auditId, domain: 'complete' });
  }

  const [exporting, setExporting] = useState(false);
  // Detailed multi-sheet .xlsx for independent verification/reconciliation
  // — a different audience than the PDF (an accountant/analyst, not a
  // glance-and-go summary), generated server-side (buildExcelWorkbook,
  // gated by reports.export) and streamed straight to a download rather
  // than assembled here, so this button carries no duplicate calculation
  // logic of its own.
  async function handleExportExcel() {
    setExporting(true);
    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      const qs = new URLSearchParams({
        slug,
        ...(customRange ? { from: customRange.from, to: customRange.to } : { period }),
        ...(selectedSheets && selectedSheets.size > 0 ? { sheets: Array.from(selectedSheets).join(',') } : {}),
      });
      const res = await fetch(`${API}/api/ai/export/excel?${qs.toString()}`, {
        headers: { Authorization: `Bearer ${session?.access_token ?? ''}` },
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body.message ?? 'Could not generate the Excel export.');
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${slug}-export-${new Date().toISOString().slice(0, 10)}.xlsx`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch {
      setError('Network error while exporting.');
    } finally {
      setExporting(false);
    }
  }

  const attCounts = useMemo(() => {
    const rows = attendance ?? [];
    const c = (s: string) => rows.filter((r) => r.status === s).length;
    return {
      present: c('present') + c('early_departure') + c('incomplete'),
      late: c('late'),
      absent: c('absent'),
      leave: c('leave'),
      total: rows.length,
    };
  }, [attendance]);
  const attendancePct = attCounts.total > 0 ? Math.round(((attCounts.present + attCounts.late) / attCounts.total) * 100) : null;

  return (
    <section className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="font-bold">Restaurant performance</h2>
        <div className="flex items-center gap-3">
          <div className="flex gap-1 rounded-lg border border-border bg-main p-1">
            {PERIODS.map((p) => (
              <button
                key={p.key}
                onClick={() => {
                  onCustomRangeChange(null);
                  onPeriodChange(p.key);
                }}
                className={`px-2.5 py-1 rounded text-[11px] font-semibold transition-colors ${
                  !customRange && period === p.key ? 'bg-primary text-primary-fg' : 'text-muted hover:text-body'
                }`}
              >
                {p.label}
              </button>
            ))}
            <button
              onClick={() => {
                setCustomDraft(customRange ?? { from: '', to: '' });
                setCustomOpen((v) => !v);
              }}
              className={`px-2.5 py-1 rounded text-[11px] font-semibold transition-colors ${
                customRange ? 'bg-primary text-primary-fg' : 'text-muted hover:text-body'
              }`}
            >
              Custom
            </button>
          </div>
          <button
            onClick={handleGenerateReport}
            disabled={loading}
            className="rounded-lg bg-primary text-primary-fg px-3 py-1.5 text-[11px] font-semibold disabled:opacity-50"
          >
            Generate Report
          </button>
          <div className="flex rounded-lg border border-border overflow-hidden">
            <button
              onClick={handleExportExcel}
              disabled={loading || exporting}
              className="bg-main px-3 py-1.5 text-[11px] font-semibold text-body hover:border-primary disabled:opacity-50"
            >
              {exporting ? 'Exporting…' : selectedSheets ? `Export Excel (${selectedSheets.size})` : 'Export Excel'}
            </button>
            <button
              onClick={() => setSheetPickerOpen((v) => !v)}
              title="Choose which sheets to export"
              className={`px-2 py-1.5 text-[11px] border-l border-border ${sheetPickerOpen || selectedSheets ? 'bg-primary/10 text-primary' : 'bg-main text-muted hover:text-body'}`}
            >
              ▾
            </button>
          </div>
        </div>
      </div>

      {sheetPickerOpen && (
        <div className="rounded-lg border border-border bg-main p-3">
          <div className="flex items-center justify-between mb-2">
            <span className="text-[11px] font-semibold text-muted">
              Export sheets — Executive Summary, Profit Summary &amp; Verification always included
            </span>
            <button onClick={() => setSelectedSheets(null)} className="text-[11px] text-primary hover:underline">
              Select all
            </button>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-1.5">
            {EXCEL_OPTIONAL_SHEETS.map((name) => {
              const checked = selectedSheets ? selectedSheets.has(name) : true;
              return (
                <label key={name} className="flex items-center gap-1.5 text-[11px] text-body">
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={(e) => {
                      setSelectedSheets((cur) => {
                        const base = cur ? new Set(cur) : new Set(EXCEL_OPTIONAL_SHEETS);
                        if (e.target.checked) base.add(name);
                        else base.delete(name);
                        return base.size === EXCEL_OPTIONAL_SHEETS.length ? null : base;
                      });
                    }}
                  />
                  {name}
                </label>
              );
            })}
          </div>
        </div>
      )}

      {customOpen && (
        <div className="flex flex-wrap items-end gap-2 rounded-lg border border-border bg-main p-3">
          <label className="text-[11px] text-muted flex flex-col gap-1">
            From
            <input
              type="date"
              value={customDraft.from}
              max={customDraft.to || undefined}
              onChange={(e) => setCustomDraft((d) => ({ ...d, from: e.target.value }))}
              className="rounded border border-border bg-surface px-2 py-1 text-xs"
            />
          </label>
          <label className="text-[11px] text-muted flex flex-col gap-1">
            To
            <input
              type="date"
              value={customDraft.to}
              min={customDraft.from || undefined}
              onChange={(e) => setCustomDraft((d) => ({ ...d, to: e.target.value }))}
              className="rounded border border-border bg-surface px-2 py-1 text-xs"
            />
          </label>
          <button
            onClick={() => {
              if (!customDraft.from || !customDraft.to) return;
              onCustomRangeChange(customDraft);
              setCustomOpen(false);
            }}
            disabled={!customDraft.from || !customDraft.to}
            className="rounded-lg bg-primary text-primary-fg px-3 py-1.5 text-[11px] font-semibold disabled:opacity-50"
          >
            Apply
          </button>
          {customRange && (
            <button
              onClick={() => {
                onCustomRangeChange(null);
                setCustomDraft({ from: '', to: '' });
                setCustomOpen(false);
              }}
              className="rounded-lg border border-border px-3 py-1.5 text-[11px] font-semibold text-muted hover:text-body"
            >
              Clear
            </button>
          )}
        </div>
      )}

      {error && <p className="text-danger text-xs">{error}</p>}

      {loading ? (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="rounded-lg border border-border bg-surface p-4 h-20 animate-pulse" />
          ))}
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <Kpi label="Net sales" value={formatCents(sales?.net_sales_cents ?? 0)} delta={sales && prevSales && <Delta curr={sales.net_sales_cents} prev={prevSales.net_sales_cents} />} />
            <Kpi label="Orders" value={String(sales?.orders_count ?? 0)} delta={sales && prevSales && <Delta curr={sales.orders_count} prev={prevSales.orders_count} />} />
            <Kpi label="AOV" value={formatCents(aov)} delta={prevAov > 0 && <Delta curr={aov} prev={prevAov} />} />
            <Kpi
              label="Customer rating"
              value={feedback?.avg_overall != null ? `★ ${feedback.avg_overall.toFixed(1)}` : '—'}
              delta={feedback ? <span className="text-muted text-[11px]">{feedback.responses} response{feedback.responses === 1 ? '' : 's'}</span> : undefined}
            />
          </div>

          {/* Profit row (spec: Net Profit belongs on the dashboard's own
             KPIs, not only /finance and AI chat — period_profitability
             already computes it, this just stops dropping the field). */}
          {canSeeProfit && profit && (
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
              <Kpi
                label="Gross profit"
                value={formatCents(profit.gross_profit_cents)}
                delta={prevProfit && <Delta curr={profit.gross_profit_cents} prev={prevProfit.gross_profit_cents} />}
                onClick={() => setDrilldownLevel('gross_profit')}
              />
              <Kpi
                label="Net profit"
                value={formatCents(profit.net_profit_cents)}
                tone={profit.net_profit_cents >= 0 ? 'ok' : 'danger'}
                delta={prevProfit && <Delta curr={profit.net_profit_cents} prev={prevProfit.net_profit_cents} />}
                onClick={() => setDrilldownLevel('net_profit')}
              />
              <Kpi label="Gross margin" value={profit.gross_margin_pct != null ? `${profit.gross_margin_pct}%` : 'N/A'} />
              <Kpi label="Net margin" value={profit.net_profit_margin_pct != null ? `${profit.net_profit_margin_pct}%` : 'N/A'} />
            </div>
          )}
          {canSeeProfit && profit && (
            <div className="rounded-lg border border-border bg-surface p-4 text-[11px] text-muted flex flex-wrap gap-x-6 gap-y-1">
              <span>Gross sales <span className="font-semibold text-body">{formatCents(profit.gross_sales_cents)}</span></span>
              <span>Discounts <span className="font-semibold text-body">-{formatCents(profit.discount_cents)}</span></span>
              <span>Refunds <span className="font-semibold text-body">-{formatCents(profit.refunded_cents)}</span></span>
              <span>COGS (theoretical) <span className="font-semibold text-body">-{formatCents(profit.theoretical_cogs_cents)}</span></span>
              <span>Expenses <span className="font-semibold text-body">-{formatCents(profit.expenses_cents)}</span></span>
              {profit.cogs_lines_missing > 0 && (
                <span className="text-warn font-semibold">
                  ⚠ {profit.cogs_lines_missing}/{profit.cogs_lines_total} sold line(s) missing a recipe — COGS understates the true figure
                </span>
              )}
              <button onClick={() => setVerifyOpen(true)} className="text-primary font-semibold underline underline-offset-2">
                Verify this calculation →
              </button>
            </div>
          )}

          <div className="grid lg:grid-cols-2 gap-6">
            <div className="rounded-lg border border-border bg-surface p-5">
              <h3 className="font-bold text-sm mb-3">Revenue mix — by category</h3>
              {categoryMix.length === 0 ? (
                <p className="text-muted text-xs">No à la carte sales in this period.</p>
              ) : (
                <div className="h-52">
                  <ResponsiveContainer width="100%" height="100%">
                    <PieChart>
                      <Pie data={categoryMix} dataKey="value" nameKey="name" innerRadius={45} outerRadius={75} paddingAngle={2} isAnimationActive>
                        {categoryMix.map((_, i) => (
                          <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />
                        ))}
                      </Pie>
                      <Tooltip content={<PieTooltip />} />
                    </PieChart>
                  </ResponsiveContainer>
                </div>
              )}
            </div>

            <div className="rounded-lg border border-border bg-surface p-5">
              <h3 className="font-bold text-sm mb-3">Payment mix</h3>
              {paymentMixData.length === 0 ? (
                <p className="text-muted text-xs">No paid orders in this period.</p>
              ) : (
                <div className="h-52">
                  <ResponsiveContainer width="100%" height="100%">
                    <PieChart>
                      <Pie data={paymentMixData} dataKey="value" nameKey="name" innerRadius={45} outerRadius={75} paddingAngle={2} isAnimationActive>
                        {paymentMixData.map((_, i) => (
                          <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />
                        ))}
                      </Pie>
                      <Tooltip content={<PieTooltip />} />
                    </PieChart>
                  </ResponsiveContainer>
                </div>
              )}
            </div>
          </div>

          <div className="rounded-lg border border-border bg-surface p-5">
            <div className="flex items-center justify-between mb-3">
              <h3 className="font-bold text-sm">Top products</h3>
              <div className="flex gap-1 rounded border border-border p-0.5">
                {(['revenue_cents', 'qty_sold'] as const).map((s) => (
                  <button
                    key={s}
                    onClick={() => setTopSort(s)}
                    className={`px-2 py-0.5 rounded text-[10px] font-semibold ${topSort === s ? 'bg-primary text-primary-fg' : 'text-muted'}`}
                  >
                    {s === 'revenue_cents' ? 'Revenue' : 'Units'}
                  </button>
                ))}
              </div>
            </div>
            {topChartData.length === 0 ? (
              <p className="text-muted text-xs">No à la carte sales in this period.</p>
            ) : (
              <div className="h-56">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={topChartData} layout="vertical" margin={{ left: 8, right: 16 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgb(var(--border-color))" horizontal={false} />
                    <XAxis type="number" tick={{ fontSize: 11, fill: 'rgb(var(--text-muted))' }} />
                    <YAxis type="category" dataKey="name" width={100} tick={{ fontSize: 11, fill: 'rgb(var(--text-muted))' }} />
                    <Tooltip
                      formatter={(v: number) => (topSort === 'revenue_cents' ? formatCents(v * 100) : v)}
                      labelFormatter={(_, p) => (p?.[0]?.payload as { fullName?: string })?.fullName ?? ''}
                    />
                    <Bar dataKey="value" fill="rgb(var(--primary))" radius={[0, 3, 3, 0]} isAnimationActive />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}
          </div>

          <div className="grid lg:grid-cols-2 gap-6">
            <div className="rounded-lg border border-border bg-surface p-5">
              <h3 className="font-bold text-sm mb-3">Staff attendance — today</h3>
              {!attendance ? (
                <p className="text-muted text-xs">Loading…</p>
              ) : attendance.length === 0 ? (
                <p className="text-muted text-xs">No active staff.</p>
              ) : (
                <>
                  <div className="flex gap-4 text-xs mb-3">
                    <span className="text-ok font-bold">{attCounts.present} present</span>
                    <span className="text-warn font-bold">{attCounts.late} late</span>
                    <span className="text-danger font-bold">{attCounts.absent} absent</span>
                    <span className="text-muted font-bold">{attCounts.leave} leave</span>
                    {attendancePct != null && <span className="ml-auto font-bold text-body">{attendancePct}%</span>}
                  </div>
                  <div className="space-y-1.5 max-h-56 overflow-y-auto">
                    {attendance.map((a) => (
                      <div key={a.membership_id} className="flex items-center gap-2 text-xs">
                        <span className={`w-2 h-2 rounded-full shrink-0 ${ATTENDANCE_DOT[a.status] ?? 'bg-border'}`} />
                        <span className="flex-1 truncate">{a.full_name ?? '—'}</span>
                        <span className="text-muted capitalize">{a.status.replace('_', ' ')}</span>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </div>

            <div className="rounded-lg border border-border bg-surface p-5">
              <h3 className="font-bold text-sm mb-3">Customer experience</h3>
              {!feedback || feedback.responses === 0 ? (
                <p className="text-muted text-xs">No feedback submitted in this period.</p>
              ) : (
                <div className="space-y-2 text-xs">
                  {(
                    [
                      ['Food', feedback.avg_food],
                      ['Service', feedback.avg_service],
                      ['Cleanliness', feedback.avg_cleanliness],
                      ['Speed', feedback.avg_speed],
                      ['Ambiance', feedback.avg_ambiance],
                      ['Overall', feedback.avg_overall],
                    ] as [string, number | null][]
                  ).map(([label, val]) => (
                    <div key={label} className="flex items-center justify-between">
                      <span className={label === 'Overall' ? 'font-bold' : 'text-muted'}>{label}</span>
                      <span className={`font-mono ${label === 'Overall' ? 'font-bold' : ''}`}>
                        {val != null ? `★ ${val.toFixed(1)}` : '—'}
                      </span>
                    </div>
                  ))}
                  <p className="text-muted text-[11px] pt-1">{feedback.responses} response{feedback.responses === 1 ? '' : 's'} this period.</p>
                </div>
              )}
            </div>
          </div>
        </>
      )}

      {verifyOpen && profit && (
        <VerifyProfitModal profit={profit} periodLabel={periodLabel} onClose={() => setVerifyOpen(false)} />
      )}
      {drilldownLevel && profit && (
        <ProfitDrilldownModal
          profit={profit}
          from={resolveRange(period, customRange).from}
          to={resolveRange(period, customRange).to}
          periodLabel={periodLabel}
          initialLevel={drilldownLevel}
          onClose={() => setDrilldownLevel(null)}
        />
      )}
    </section>
  );
}

/**
 * Profit Verification (spec §27): the exact formula with the real values
 * already sitting in `profit` — no second calculation, just laid out so an
 * owner or accountant can check it line by line — plus an honest
 * data-quality checklist. Never claims a check passed that isn't actually
 * true for THIS period's data.
 */
function VerifyProfitModal({
  profit,
  periodLabel,
  onClose,
}: {
  profit: NonNullable<Profitability>;
  periodLabel: string;
  onClose: () => void;
}) {
  const row = (label: string, value: string, opts?: { bold?: boolean; sub?: boolean }) => (
    <div className={`flex items-center justify-between py-1 ${opts?.sub ? 'pl-3 text-muted' : ''}`}>
      <span className={opts?.bold ? 'font-bold' : ''}>{label}</span>
      <span className={`font-mono ${opts?.bold ? 'font-bold' : ''}`}>{value}</span>
    </div>
  );
  const checks: { ok: boolean; text: string }[] = [
    { ok: true, text: `Sales scoped to ${periodLabel} (served/paid orders only — cancelled, void, and other-tenant orders are never counted).` },
    { ok: profit.cogs_lines_missing === 0, text: profit.cogs_lines_missing === 0
        ? 'Every sold line had a recipe configured — COGS reflects the full period.'
        : `${profit.cogs_lines_missing} of ${profit.cogs_lines_total} sold line(s) have no recipe configured — theoretical COGS and gross profit understate the true figure.` },
    { ok: true, text: `Actual ingredient value consumed/wasted/adjusted this period (from the stock ledger): ${formatCents(profit.actual_cogs_cents)}${profit.cogs_variance_cents !== 0 ? ` — ${profit.cogs_variance_cents > 0 ? 'above' : 'below'} the recipe-based figure by ${formatCents(Math.abs(profit.cogs_variance_cents))}.` : ' — matches the recipe-based figure.'}` },
    { ok: true, text: `Expenses included: ${formatCents(profit.expenses_cents)} across all recorded expense records dated in this period, any category.` },
    { ok: false, text: 'Labor/payroll cost is NOT separately tracked — it is only reflected here if it was entered as an expense record. If it wasn’t, Net Profit above overstates true profit by that amount.' },
    { ok: true, text: 'No duplicate-order or duplicate-expense detection has run automatically — each figure is a straight sum of the underlying records for this period.' },
  ];
  const fullyCalculated = checks.every((c) => c.ok);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div className="max-w-lg w-full max-h-[85vh] overflow-y-auto rounded-lg border border-border bg-surface p-5 space-y-4" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h3 className="font-black text-sm">Profit Verification — {periodLabel}</h3>
          <button onClick={onClose} className="text-muted text-xs">✕</button>
        </div>

        <div className="text-xs border border-border rounded-lg p-3 space-y-0.5">
          {row('Gross sales', formatCents(profit.gross_sales_cents))}
          {row('− Discounts', `-${formatCents(profit.discount_cents)}`, { sub: true })}
          {row('− Refunds', `-${formatCents(profit.refunded_cents)}`, { sub: true })}
          {row('= Net sales', formatCents(profit.net_sales_cents), { bold: true })}
          {row('− COGS (theoretical)', `-${formatCents(profit.theoretical_cogs_cents)}`, { sub: true })}
          {row('= Gross profit', formatCents(profit.gross_profit_cents), { bold: true })}
          {row('− Expenses (all recorded)', `-${formatCents(profit.expenses_cents)}`, { sub: true })}
          {row('= Net profit', formatCents(profit.net_profit_cents), { bold: true })}
          <div className="flex items-center justify-between pt-1 text-muted">
            <span>Gross margin / Net margin</span>
            <span className="font-mono">
              {profit.gross_margin_pct != null ? `${profit.gross_margin_pct}%` : 'N/A'} / {profit.net_profit_margin_pct != null ? `${profit.net_profit_margin_pct}%` : 'N/A'}
            </span>
          </div>
        </div>

        <div>
          <p className={`text-xs font-bold mb-2 ${fullyCalculated ? 'text-ok' : 'text-warn'}`}>
            {fullyCalculated ? '✓ Fully calculated from recorded data' : '⚠ Partially calculated — see below'}
          </p>
          <ul className="space-y-1.5 text-[11px]">
            {checks.map((c, i) => (
              <li key={i} className={c.ok ? 'text-body' : 'text-warn'}>
                {c.ok ? '✓' : '⚠'} {c.text}
              </li>
            ))}
          </ul>
        </div>

        <p className="text-[10px] text-muted">
          These figures come from the same period_profitability calculation used by this dashboard, the Finance page, generated reports, and the AI assistant — there is one calculation engine, not a separate one per screen.
        </p>
      </div>
    </div>
  );
}
