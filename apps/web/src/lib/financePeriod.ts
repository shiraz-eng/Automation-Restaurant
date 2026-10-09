// Business-date ranges for the Finance pages, in the RESTAURANT's own time
// zone (not the server's or the viewer's): "today" is the restaurant's today.
// Every range is inclusive YYYY-MM-DD, matching ledger_summary / ledger_events
// (financial_events.business_date). `prev*` is the equally long period just
// before, for "vs previous period" comparisons.

export type FinancePeriod = 'today' | 'yesterday' | '7d' | 'month' | 'last_month' | '30d' | 'custom';

export const PERIOD_LABELS: Record<Exclude<FinancePeriod, 'custom'>, string> = {
  today: 'Today',
  yesterday: 'Yesterday',
  '7d': 'Last 7 days',
  month: 'This month',
  last_month: 'Last month',
  '30d': 'Last 30 days',
};

const isYmd = (s: unknown): s is string => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);

export function todayIn(timeZone: string): string {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

function addDays(ymd: string, n: number): string {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);

export function resolveFinancePeriod(
  raw: { period?: string; from?: string; to?: string },
  timeZone: string,
): { period: FinancePeriod; from: string; to: string; prevFrom: string; prevTo: string; label: string } {
  const today = todayIn(timeZone);
  let period = (raw.period as FinancePeriod) ?? 'month';
  let from = today;
  let to = today;
  if (period === 'custom' && isYmd(raw.from) && isYmd(raw.to) && raw.from <= raw.to) {
    from = raw.from;
    to = raw.to;
  } else {
    if (period === 'custom' || !(period in PERIOD_LABELS)) period = 'month';
    if (period === 'yesterday') from = to = addDays(today, -1);
    else if (period === '7d') from = addDays(today, -6);
    else if (period === '30d') from = addDays(today, -29);
    else if (period === 'month') from = `${today.slice(0, 7)}-01`;
    else if (period === 'last_month') {
      const firstThis = `${today.slice(0, 7)}-01`;
      to = addDays(firstThis, -1);
      from = `${to.slice(0, 7)}-01`;
    }
  }
  const len = daysBetween(from, to) + 1;
  let prevTo = addDays(from, -1);
  let prevFrom = addDays(prevTo, -(len - 1));
  if (period === 'month' || period === 'last_month') {
    // Calendar comparison: the previous month (to the same day for "this month").
    const prevMonthEnd = addDays(`${from.slice(0, 7)}-01`, -1);
    prevFrom = `${prevMonthEnd.slice(0, 7)}-01`;
    prevTo = period === 'month' ? (addDays(prevFrom, len - 1) <= prevMonthEnd ? addDays(prevFrom, len - 1) : prevMonthEnd) : prevMonthEnd;
  }
  const label = period === 'custom' ? `${from} → ${to}` : PERIOD_LABELS[period];
  return { period, from, to, prevFrom, prevTo, label };
}
