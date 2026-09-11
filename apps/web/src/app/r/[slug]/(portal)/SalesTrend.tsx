'use client';

import { useEffect, useMemo, useState } from 'react';
import { usePortalSupabase } from '@/components/PortalProvider';
import { formatCents, formatDateTime } from '@/lib/format';
import {
  ResponsiveContainer,
  LineChart,
  Line,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  type TooltipProps,
} from 'recharts';

export type DayRow = {
  business_date: string;
  gross_sales_cents: number;
  discount_cents: number;
  refunded_cents: number;
  net_sales_cents: number;
  orders_count: number;
};
type HourRow = { hour_of_day: number; net_sales_cents: number; orders_count: number };
type OrderRow = {
  order_id: string;
  order_number: number;
  status: string;
  channel: string;
  table_label: string | null;
  total_cents: number;
  discount_cents: number;
  event_at: string;
};

function monthRange(monthStr: string) {
  const [y, m] = monthStr.split('-').map(Number);
  const from = new Date(y, m - 1, 1);
  const to = new Date(y, m, 0); // last day of that month
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  return { from: iso(from), to: iso(to) };
}

function DayTooltip({ active, payload }: TooltipProps<number, string>) {
  if (!active || !payload || !payload[0]) return null;
  const d = payload[0].payload as { date: string; row: DayRow };
  const aov = d.row.orders_count > 0 ? Math.round(d.row.net_sales_cents / d.row.orders_count) : 0;
  return (
    <div className="rounded border border-border bg-surface px-3 py-2 text-[11px] shadow-lg space-y-0.5">
      <p className="font-bold text-body mb-1">{d.date}</p>
      <p className="text-muted">
        Gross <span className="font-mono text-body">{formatCents(d.row.gross_sales_cents)}</span>
      </p>
      <p className="text-muted">
        Discounts <span className="font-mono text-body">{formatCents(d.row.discount_cents)}</span>
      </p>
      <p className="text-muted">
        Refunds <span className="font-mono text-body">{formatCents(d.row.refunded_cents)}</span>
      </p>
      <p className="text-muted">
        Net <span className="font-mono font-bold text-body">{formatCents(d.row.net_sales_cents)}</span>
      </p>
      <p className="text-muted">
        Orders <span className="font-mono text-body">{d.row.orders_count}</span> · AOV{' '}
        <span className="font-mono text-body">{formatCents(aov)}</span>
      </p>
    </div>
  );
}

function HourTooltip({ active, payload }: TooltipProps<number, string>) {
  if (!active || !payload || !payload[0]) return null;
  const h = payload[0].payload as { hour: string; net_sales_cents: number; orders_count: number };
  return (
    <div className="rounded border border-border bg-surface px-3 py-2 text-[11px] shadow-lg">
      <p className="font-bold text-body">{h.hour}</p>
      <p className="text-muted">
        Net <span className="font-mono text-body">{formatCents(h.net_sales_cents)}</span> · {h.orders_count} orders
      </p>
    </div>
  );
}

/**
 * The dashboard's core visual: one line-chart point per real business day
 * (never a manufactured future day — spec §5-6, §34), with a day picker
 * that drills into that day's hourly bars and underlying orders (spec §7-9).
 * All three RPCs (sales_by_day / sales_by_hour / orders_on_day) share the
 * exact same "what counts as a sale" population as app.day_sales(), so this
 * chart can never disagree with the daily-closing numbers elsewhere.
 */
export function SalesTrend({ initialMonth, initialDays }: { initialMonth: string; initialDays: DayRow[] }) {
  const supabase = usePortalSupabase();
  const [month, setMonth] = useState(initialMonth);
  const [days, setDays] = useState<DayRow[]>(initialDays);
  const [loadingDays, setLoadingDays] = useState(false);
  const [selectedDay, setSelectedDay] = useState<string | null>(null);
  const [hourly, setHourly] = useState<HourRow[] | null>(null);
  const [dayOrders, setDayOrders] = useState<OrderRow[] | null>(null);
  const [loadingDay, setLoadingDay] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (month === initialMonth) {
      setDays(initialDays);
      return;
    }
    let cancelled = false;
    setLoadingDays(true);
    setError(null);
    const { from, to } = monthRange(month);
    supabase
      .rpc('sales_by_day', { p_from: from, p_to: to })
      .then(({ data, error: err }) => {
        if (cancelled) return;
        setLoadingDays(false);
        if (err) {
          setError(err.message);
          return;
        }
        setDays((data as DayRow[]) ?? []);
      });
    return () => {
      cancelled = true;
    };
  }, [month, initialMonth, initialDays, supabase]);

  async function selectDay(date: string) {
    setSelectedDay(date);
    setLoadingDay(true);
    setError(null);
    const [hourRes, orderRes] = await Promise.all([
      supabase.rpc('sales_by_hour', { p_date: date }),
      supabase.rpc('orders_on_day', { p_date: date }),
    ]);
    setLoadingDay(false);
    if (hourRes.error) {
      setError(hourRes.error.message);
      return;
    }
    if (orderRes.error) {
      setError(orderRes.error.message);
      return;
    }
    setHourly((hourRes.data as HourRow[]) ?? []);
    setDayOrders((orderRes.data as OrderRow[]) ?? []);
  }

  function clearDay() {
    setSelectedDay(null);
    setHourly(null);
    setDayOrders(null);
  }

  const chartData = useMemo(
    () =>
      days.map((d) => ({
        day: Number(d.business_date.slice(-2)),
        date: d.business_date,
        net: d.net_sales_cents / 100,
        row: d,
      })),
    [days],
  );
  const hasAnySales = days.some((d) => d.orders_count > 0);
  const monthTotal = days.reduce((s, d) => s + d.net_sales_cents, 0);
  const monthOrders = days.reduce((s, d) => s + d.orders_count, 0);
  const dayRow = selectedDay ? (days.find((d) => d.business_date === selectedDay) ?? null) : null;
  const hourlyChartData = (hourly ?? []).map((h) => ({
    hour: `${String(h.hour_of_day).padStart(2, '0')}:00`,
    net_sales_cents: h.net_sales_cents,
    orders_count: h.orders_count,
    net: h.net_sales_cents / 100,
  }));

  return (
    <section className="rounded-lg border border-border bg-surface p-5">
      <div className="flex flex-wrap items-center justify-between gap-3 mb-1">
        <h2 className="font-bold">Sales trend</h2>
        <input
          type="month"
          value={month}
          onChange={(e) => {
            setMonth(e.target.value);
            clearDay();
          }}
          className="rounded border border-border bg-main px-2 py-1 text-xs outline-none focus:border-primary"
        />
      </div>

      {error && <p className="text-danger text-xs mt-2">{error}</p>}

      <div className="flex gap-6 text-xs text-muted my-3">
        <span>
          Net sales <span className="font-bold text-body font-mono">{formatCents(monthTotal)}</span>
        </span>
        <span>
          Orders <span className="font-bold text-body font-mono">{monthOrders}</span>
        </span>
      </div>

      {loadingDays ? (
        <p className="text-muted text-xs">Loading…</p>
      ) : !hasAnySales ? (
        <p className="text-muted text-xs">No sales recorded yet for this period.</p>
      ) : (
        <div className="h-56">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={chartData} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgb(var(--border-color))" />
              <XAxis dataKey="day" tick={{ fontSize: 11, fill: 'rgb(var(--text-muted))' }} />
              <YAxis
                tick={{ fontSize: 11, fill: 'rgb(var(--text-muted))' }}
                tickFormatter={(v: number) => `$${v}`}
                width={52}
              />
              <Tooltip content={<DayTooltip />} />
              <Line
                type="monotone"
                dataKey="net"
                stroke="rgb(var(--primary))"
                strokeWidth={2}
                dot={{ r: 2, fill: 'rgb(var(--primary))' }}
                activeDot={{
                  r: 5,
                  cursor: 'pointer',
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  onClick: (...args: any[]) => {
                    const date = args.find((a) => a?.payload?.date)?.payload?.date as string | undefined;
                    if (date) selectDay(date);
                  },
                }}
                isAnimationActive
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}

      <div className="mt-4 flex items-center gap-2">
        <label className="text-[11px] text-muted font-semibold">Day</label>
        <select
          value={selectedDay ?? ''}
          onChange={(e) => (e.target.value ? selectDay(e.target.value) : clearDay())}
          className="rounded border border-border bg-main px-2 py-1 text-xs outline-none focus:border-primary"
        >
          <option value="">— pick a day —</option>
          {days
            .slice()
            .reverse()
            .map((d) => (
              <option key={d.business_date} value={d.business_date}>
                {d.business_date} — {formatCents(d.net_sales_cents)}
              </option>
            ))}
        </select>
      </div>

      {selectedDay && (
        <div className="mt-4 border-t border-border pt-4">
          {loadingDay ? (
            <p className="text-muted text-xs">Loading…</p>
          ) : (
            <>
              <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 mb-4 text-xs">
                <div>
                  <div className="text-muted">Net sales</div>
                  <div className="font-bold font-mono">{formatCents(dayRow?.net_sales_cents ?? 0)}</div>
                </div>
                <div>
                  <div className="text-muted">Orders</div>
                  <div className="font-bold font-mono">{dayRow?.orders_count ?? 0}</div>
                </div>
                <div>
                  <div className="text-muted">AOV</div>
                  <div className="font-bold font-mono">
                    {formatCents(dayRow && dayRow.orders_count > 0 ? Math.round(dayRow.net_sales_cents / dayRow.orders_count) : 0)}
                  </div>
                </div>
                <div>
                  <div className="text-muted">Discounts</div>
                  <div className="font-bold font-mono">{formatCents(dayRow?.discount_cents ?? 0)}</div>
                </div>
                <div>
                  <div className="text-muted">Refunds</div>
                  <div className="font-bold font-mono">{formatCents(dayRow?.refunded_cents ?? 0)}</div>
                </div>
              </div>

              {hourly && (dayRow?.orders_count ?? 0) > 0 && (
                <div className="h-40 mb-4">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={hourlyChartData} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="rgb(var(--border-color))" />
                      <XAxis dataKey="hour" tick={{ fontSize: 9, fill: 'rgb(var(--text-muted))' }} interval={2} />
                      <YAxis
                        tick={{ fontSize: 11, fill: 'rgb(var(--text-muted))' }}
                        tickFormatter={(v: number) => `$${v}`}
                        width={52}
                      />
                      <Tooltip content={<HourTooltip />} cursor={{ fill: 'rgb(var(--border-color) / 0.4)' }} />
                      <Bar dataKey="net" fill="rgb(var(--primary))" radius={[3, 3, 0, 0]} isAnimationActive />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              )}

              <h3 className="text-xs font-bold text-muted mb-2">Orders — {selectedDay}</h3>
              {!dayOrders || dayOrders.length === 0 ? (
                <p className="text-muted text-xs">No orders this day.</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-xs">
                    <tbody>
                      {dayOrders.map((o) => (
                        <tr key={o.order_id} className="border-b border-border/50 last:border-0">
                          <td className="py-1.5 font-mono font-bold">#{o.order_number}</td>
                          <td className="py-1.5 text-muted">{o.table_label ?? o.channel.replace('_', ' ')}</td>
                          <td className="py-1.5 text-muted">{o.status.replace('_', ' ')}</td>
                          <td className="py-1.5 text-right font-bold">{formatCents(o.total_cents)}</td>
                          <td className="py-1.5 text-right text-muted">{formatDateTime(o.event_at)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </section>
  );
}
