'use client';

import { useEffect, useMemo, useState } from 'react';
import { usePortalSupabase } from '@/components/PortalProvider';
import { formatCents } from '@/lib/format';
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

type Period = 'today' | 'yesterday' | 'this_week' | 'last_week' | 'this_month' | 'last_month';
const PERIODS: { key: Period; label: string }[] = [
  { key: 'today', label: 'Today' },
  { key: 'yesterday', label: 'Yesterday' },
  { key: 'this_week', label: 'This week' },
  { key: 'last_week', label: 'Last week' },
  { key: 'this_month', label: 'This month' },
  { key: 'last_month', label: 'Last month' },
];

function periodRange(period: Period) {
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
    default: {
      const from = today0;
      return { from, to: addDays(today0, 1), prevFrom: addDays(from, -1), prevTo: from };
    }
  }
}
const asDate = (d: Date) => d.toISOString().slice(0, 10);

type DaySum = { net_sales_cents: number; orders_count: number };
type Profitability = { gross_profit_cents: number; food_cost_pct: number | null } | null;
type Slice = { name: string; value: number };
type ItemRow = { name: string; qty_sold: number; revenue_cents: number };
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

function Kpi({ label, value, delta }: { label: string; value: string; delta?: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-border bg-surface p-4">
      <div className="text-muted text-[11px] font-semibold">{label}</div>
      <div className="mt-1 text-xl font-black tabular-nums transition-all">{value}</div>
      {delta && <div className="mt-1">{delta}</div>}
    </div>
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
export function PerformancePanel() {
  const supabase = usePortalSupabase();
  const [period, setPeriod] = useState<Period>('today');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

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

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    const { from, to, prevFrom, prevTo } = periodRange(period);

    async function sumDays(from: Date, to: Date): Promise<DaySum> {
      const { data, error: err } = await supabase.rpc('sales_by_day', { p_from: asDate(from), p_to: asDate(to) });
      if (err) throw err;
      const rows = (data as { net_sales_cents: number; orders_count: number }[]) ?? [];
      return {
        net_sales_cents: rows.reduce((s, r) => s + r.net_sales_cents, 0),
        orders_count: rows.reduce((s, r) => s + r.orders_count, 0),
      };
    }

    (async () => {
      try {
        const [curr, prev] = await Promise.all([sumDays(from, to), sumDays(prevFrom, prevTo)]);
        if (cancelled) return;
        setSales(curr);
        setPrevSales(prev);

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
        if (itemRes.error) throw itemRes.error;
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
        setTopItems(
          ((itemRes.data as { name: string; qty_sold: number; revenue_cents: number }[]) ?? []).slice(0, 8),
        );
        setFeedback((fbRes.data as FeedbackRow[] | null)?.[0] ?? null);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [period, supabase]);

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
        <div className="flex gap-1 rounded-lg border border-border bg-main p-1">
          {PERIODS.map((p) => (
            <button
              key={p.key}
              onClick={() => setPeriod(p.key)}
              className={`px-2.5 py-1 rounded text-[11px] font-semibold transition-colors ${
                period === p.key ? 'bg-primary text-primary-fg' : 'text-muted hover:text-body'
              }`}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>

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
            {canSeeProfit && profit && (
              <>
                <Kpi
                  label="Gross profit"
                  value={formatCents(profit.gross_profit_cents)}
                  delta={prevProfit && <Delta curr={profit.gross_profit_cents} prev={prevProfit.gross_profit_cents} />}
                />
                <Kpi label="Food cost" value={profit.food_cost_pct != null ? `${profit.food_cost_pct}%` : '—'} />
              </>
            )}
          </div>

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
    </section>
  );
}
