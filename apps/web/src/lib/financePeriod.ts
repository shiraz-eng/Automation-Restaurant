// Business-date ranges for the Finance pages, in the RESTAURANT's own time
// zone (not the server's or the viewer's): "today" is the restaurant's today.
// Every range is inclusive YYYY-MM-DD, matching ledger_summary / ledger_events
// (financial_events.business_date) and expenses.expense_date. `prev*` is the
// equally long period just before, for "vs previous period" comparisons. A
// picked month arrives as a custom range covering exactly that month.

export type FinancePeriod = 'today' | 'yesterday' | '7d' | 'month' | 'last_month' | '30d' | 'this_year' | 'custom';

export const PERIOD_LABELS: Record<Exclude<FinancePeriod, 'custom'>, string> = {
  today: 'Today',
  yesterday: 'Yesterday',
  '7d': 'Last 7 days',
  month: 'This month',
  last_month: 'Last month',
  '30d': 'Last 30 days',
  this_year: 'This year',
};

const isYmd = (s: unknown): s is string => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);

export function todayIn(timeZone: string): string {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

export function addDays(ymd: string, n: number): string {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);

/** Last day of the month containing `ymd`. */
export function monthEnd(ymd: string): string {
  return addDays(`${shiftMonth(ymd.slice(0, 7), 1)}-01`, -1);
}
/** "2026-10" moved by n months. */
export function shiftMonth(ym: string, n: number): string {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return d.toISOString().slice(0, 7);
}
/** True when from..to is exactly one calendar month. */
export function isWholeMonth(from: string, to: string): boolean {
  return from.endsWith('-01') && to === monthEnd(from);
}
/** Every "YYYY-MM" the range touches, oldest first. */
export function monthsInRange(from: string, to: string): string[] {
  const out: string[] = [];
  for (let ym = from.slice(0, 7); ym <= to.slice(0, 7); ym = shiftMonth(ym, 1)) out.push(ym);
  return out;
}
export function monthLabel(ym: string): string {
  const [y, m] = ym.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
}
/** "1 Oct – 10 Oct 2026" style label for a range. */
export function rangeLabel(from: string, to: string): string {
  const f = (ymd: string, withYear: boolean) =>
    new Date(`${ymd}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', ...(withYear ? { year: 'numeric' } : {}), timeZone: 'UTC' });
  if (isWholeMonth(from, to)) return monthLabel(from.slice(0, 7));
  if (from === to) return f(from, true);
  return `${f(from, from.slice(0, 4) !== to.slice(0, 4))} – ${f(to, true)}`;
}

/** The UTC instant of midnight at the start of `ymd` in the restaurant's time zone. */
export function zonedDayStart(ymd: string, timeZone: string): Date {
  const guess = new Date(`${ymd}T00:00:00Z`);
  try {
    const p = new Intl.DateTimeFormat('en-US', {
      timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(guess);
    const g = (t: string) => Number(p.find((x) => x.type === t)?.value);
    const offset = Date.UTC(g('year'), g('month') - 1, g('day'), g('hour'), g('minute'), g('second')) - guess.getTime();
    return new Date(guess.getTime() - offset);
  } catch {
    return guess;
  }
}

export type ResolvedFinancePeriod = {
  period: FinancePeriod;
  from: string;
  to: string;
  prevFrom: string;
  prevTo: string;
  label: string;
};

export function resolveFinancePeriod(
  raw: { period?: string; from?: string; to?: string },
  timeZone: string,
  fallback: Exclude<FinancePeriod, 'custom'> = 'month',
): ResolvedFinancePeriod {
  const today = todayIn(timeZone);
  let period = (raw.period as FinancePeriod) ?? fallback;
  let from = today;
  let to = today;
  // A from/to pair without a named period (links from other screens) is a custom range.
  if (!raw.period && isYmd(raw.from) && isYmd(raw.to)) period = 'custom';
  if (period === 'custom' && isYmd(raw.from) && isYmd(raw.to) && raw.from <= raw.to) {
    from = raw.from;
    to = raw.to;
  } else {
    if (period === 'custom' || !(period in PERIOD_LABELS)) period = fallback;
    if (period === 'yesterday') from = to = addDays(today, -1);
    else if (period === '7d') from = addDays(today, -6);
    else if (period === '30d') from = addDays(today, -29);
    else if (period === 'month') from = `${today.slice(0, 7)}-01`;
    else if (period === 'this_year') from = `${today.slice(0, 4)}-01-01`;
    else if (period === 'last_month') {
      from = `${shiftMonth(today.slice(0, 7), -1)}-01`;
      to = monthEnd(from);
    }
  }
  const len = daysBetween(from, to) + 1;
  let prevTo = addDays(from, -1);
  let prevFrom = addDays(prevTo, -(len - 1));
  if (period === 'month' || period === 'last_month' || (period === 'custom' && isWholeMonth(from, to))) {
    // Calendar comparison: the previous month (to the same day for "this month").
    prevFrom = `${shiftMonth(from.slice(0, 7), -1)}-01`;
    const prevMonthEnd = monthEnd(prevFrom);
    prevTo = period === 'month' ? (addDays(prevFrom, len - 1) <= prevMonthEnd ? addDays(prevFrom, len - 1) : prevMonthEnd) : prevMonthEnd;
  } else if (period === 'this_year') {
    prevFrom = `${Number(from.slice(0, 4)) - 1}-01-01`;
    prevTo = addDays(prevFrom, len - 1);
  }
  const label = period === 'custom' ? rangeLabel(from, to) : PERIOD_LABELS[period];
  return { period, from, to, prevFrom, prevTo, label };
}
