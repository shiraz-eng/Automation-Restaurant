'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { usePortalSupabase } from '@/components/PortalProvider';
import { Button, Card, Field, Input, Select } from '@/components/ui';
import { formatDateTime } from '@/lib/format';

export type AttendanceCaps = {
  /** attendance.view_dashboard — today's headcount tiles (attendance_dashboard). */
  dashboard: boolean;
  /** attendance.view_reports — monthly report for every staff member. */
  reports: boolean;
  /** attendance.view_employee_reports — monthly report for one chosen employee. */
  employeeReports: boolean;
  /** attendance.view_history — day-by-day log over a date range (attendance_history). */
  history: boolean;
  /** attendance.export — download the report/history as CSV. */
  exportCsv: boolean;
  /** attendance.request_correction — ask for a day's times to be fixed. */
  requestCorrection: boolean;
  /** attendance.correct — fix a day's times directly. */
  correct: boolean;
  /** attendance.approve_correction — approve/reject pending requests. */
  approveCorrection: boolean;
  /** attendance.view_own — the signed-in staff member's own month. */
  viewOwn: boolean;
};

type StaffRow = { membership_id: string; full_name: string | null; email: string; role: string };
type Dashboard = {
  total_staff: number;
  present: number;
  late: number;
  absent: number;
  on_leave: number;
  checked_out: number;
  not_marked: number;
  worked_minutes: number;
};
type Summary = {
  scheduled_days: number;
  present: number;
  absent: number;
  late: number;
  leave: number;
  worked_minutes: number;
  approved_overtime_minutes: number;
  attendance_pct: number | null;
};
type HistoryRow = {
  id: string;
  membership_id: string;
  full_name: string | null;
  email: string;
  business_date: string;
  clock_in: string | null;
  clock_out: string | null;
  status: string | null;
  late_minutes: number;
  worked_minutes: number;
  overtime_minutes: number;
  source: string;
};
type Correction = {
  id: string;
  membership_id: string;
  business_date: string;
  requested_clock_in: string | null;
  requested_clock_out: string | null;
  reason: string;
  status: 'pending' | 'approved' | 'rejected';
  requested_by_email: string | null;
  reviewed_by_email: string | null;
  review_note: string | null;
  created_at: string;
};

function iso(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function hours(min: number): string {
  return `${(Number(min) / 60).toFixed(1)}h`;
}
function time(ts: string | null): string {
  return ts ? new Date(ts).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) : '—';
}
function staffName(s: { full_name: string | null; email: string }): string {
  return s.full_name?.trim() || s.email;
}
function toTs(date: string, hhmm: string): string | null {
  if (!hhmm) return null;
  const d = new Date(`${date}T${hhmm}`);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}
function downloadCsv(filename: string, header: string[], rows: (string | number | null)[][]) {
  const esc = (v: string | number | null) => {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const csv = [header, ...rows].map((r) => r.map(esc).join(',')).join('\n');
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/**
 * The fine-grained attendance permissions, each as its own panel. Every
 * number comes from an RPC that checks the same key server-side
 * (tenant-migrations/0058 + attendance_month_summary from 0053); this
 * component only decides which panels to show.
 */
export function AttendanceInsights({ caps, myMembershipId }: { caps: AttendanceCaps; myMembershipId: string | null }) {
  const supabase = usePortalSupabase();
  const [staff, setStaff] = useState<StaffRow[]>([]);
  const needsStaff =
    caps.reports || caps.employeeReports || caps.history || caps.correct || caps.requestCorrection || caps.approveCorrection;

  useEffect(() => {
    if (!needsStaff) return;
    void supabase.rpc('attendance_staff_list').then(({ data }) => setStaff((data ?? []) as StaffRow[]));
  }, [supabase, needsStaff]);

  const nameOf = useMemo(() => {
    const m = new Map(staff.map((s) => [s.membership_id, staffName(s)]));
    return (id: string) => m.get(id) ?? 'Staff member';
  }, [staff]);

  return (
    <div className="space-y-4">
      {caps.dashboard && <DashboardTiles />}
      {caps.viewOwn && <MyAttendance myMembershipId={myMembershipId} canRequest={caps.requestCorrection} />}
      {(caps.reports || caps.employeeReports) && (
        <MonthlyReport staff={staff} allStaff={caps.reports} canExport={caps.exportCsv} />
      )}
      {caps.history && <History staff={staff} canExport={caps.exportCsv} />}
      {(caps.requestCorrection || caps.correct || caps.approveCorrection) && (
        <Corrections
          staff={staff}
          nameOf={nameOf}
          canRequest={caps.requestCorrection}
          canCorrect={caps.correct}
          canApprove={caps.approveCorrection}
        />
      )}
    </div>
  );
}

function DashboardTiles() {
  const supabase = usePortalSupabase();
  const [d, setD] = useState<Dashboard | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void supabase.rpc('attendance_dashboard', {}).then(({ data, error: e }) => {
      if (e) setError(e.message);
      else setD(((data ?? []) as Dashboard[])[0] ?? null);
    });
  }, [supabase]);
  if (error) return <Card className="text-danger text-xs">{error}</Card>;
  if (!d) return <Card className="text-muted text-xs">Loading today&rsquo;s attendance…</Card>;
  const tiles: [string, number | string, string][] = [
    ['Staff', d.total_staff, 'text-body'],
    ['Present', d.present, 'text-ok'],
    ['Late', d.late, 'text-warn'],
    ['Absent', d.absent, 'text-danger'],
    ['On leave / off', d.on_leave, 'text-muted'],
    ['Not marked', d.not_marked, 'text-warn'],
    ['Checked out', d.checked_out, 'text-body'],
    ['Hours worked', hours(d.worked_minutes), 'text-body'],
  ];
  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
      {tiles.map(([label, value, tone]) => (
        <div key={label} className="rounded-lg border border-border bg-surface p-3">
          <div className="text-[10px] uppercase tracking-wide text-muted font-bold">{label}</div>
          <div className={`text-lg font-black tabular-nums ${tone}`}>{value}</div>
        </div>
      ))}
    </div>
  );
}

function MyAttendance({ myMembershipId, canRequest }: { myMembershipId: string | null; canRequest: boolean }) {
  const supabase = usePortalSupabase();
  const [s, setS] = useState<Summary | null>(null);
  const [rows, setRows] = useState<HistoryRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!myMembershipId) return;
    const now = new Date();
    const from = new Date(now.getFullYear(), now.getMonth(), 1);
    void Promise.all([
      supabase.rpc('attendance_month_summary', {
        p_membership_id: myMembershipId,
        p_year: now.getFullYear(),
        p_month: now.getMonth() + 1,
      }),
      supabase.rpc('attendance_history', { p_from: iso(from), p_to: iso(now), p_membership_id: myMembershipId }),
    ]).then(([sum, hist]) => {
      if (sum.error) setError(sum.error.message);
      else setS(sum.data as Summary);
      setRows((hist.data ?? []) as HistoryRow[]);
    });
  }, [supabase, myMembershipId]);

  return (
    <Card>
      <h3 className="font-bold text-sm mb-2">My attendance</h3>
      {!myMembershipId ? (
        <p className="text-muted text-xs">
          This login isn&rsquo;t a staff member. Staff see their own month here when they sign in with their own account.
        </p>
      ) : error ? (
        <p className="text-danger text-xs">{error}</p>
      ) : !s ? (
        <p className="text-muted text-xs">Loading…</p>
      ) : (
        <>
          <p className="text-xs tabular-nums">
            This month: <b>{s.present}</b> present of {s.scheduled_days} scheduled · {s.late} late · {s.absent} absent ·{' '}
            {hours(s.worked_minutes)} worked{s.attendance_pct != null ? ` · ${s.attendance_pct}%` : ''}
          </p>
          {rows.length > 0 && (
            <table className="w-full text-left text-xs mt-3 tabular-nums">
              <tbody>
                {rows.slice(0, 10).map((r) => (
                  <tr key={r.id} className="border-b border-border/60 last:border-0">
                    <td className="py-1.5">{r.business_date}</td>
                    <td className="py-1.5">
                      {time(r.clock_in)} – {time(r.clock_out)}
                    </td>
                    <td className="py-1.5 capitalize text-muted">{r.status?.replace('_', ' ') ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {canRequest && <p className="text-muted text-[11px] mt-2">Something wrong? Request a correction below.</p>}
        </>
      )}
    </Card>
  );
}

function MonthlyReport({ staff, allStaff, canExport }: { staff: StaffRow[]; allStaff: boolean; canExport: boolean }) {
  const supabase = usePortalSupabase();
  const now = new Date();
  const [month, setMonth] = useState(`${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`);
  const [who, setWho] = useState('');
  const [rows, setRows] = useState<{ member: StaffRow; s: Summary }[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(async () => {
    const [y, m] = month.split('-').map((n) => parseInt(n, 10));
    const targets = allStaff && !who ? staff : staff.filter((s) => s.membership_id === who);
    if (targets.length === 0) {
      setRows([]);
      return;
    }
    setLoading(true);
    setError(null);
    const results = await Promise.all(
      targets.map((member) =>
        supabase
          .rpc('attendance_month_summary', { p_membership_id: member.membership_id, p_year: y, p_month: m })
          .then(({ data, error: e }) => ({ member, s: data as Summary | null, e })),
      ),
    );
    const firstErr = results.find((r) => r.e);
    if (firstErr?.e) setError(firstErr.e.message);
    setRows(results.filter((r) => r.s).map((r) => ({ member: r.member, s: r.s as Summary })));
    setLoading(false);
  }, [supabase, month, who, staff, allStaff]);

  useEffect(() => {
    if (allStaff || who) void run();
  }, [run, allStaff, who]);

  return (
    <Card className="p-0 overflow-hidden">
      <div className="flex flex-wrap items-end justify-between gap-3 p-3 border-b border-border">
        <div>
          <h3 className="font-bold text-sm">Monthly attendance report</h3>
          <p className="text-muted text-[11px]">{allStaff ? 'Every staff member, or pick one.' : 'Pick an employee.'}</p>
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <Field label="Month">
            <Input type="month" value={month} onChange={(e) => setMonth(e.target.value)} className="w-40" />
          </Field>
          <Field label="Employee">
            <Select value={who} onChange={(e) => setWho(e.target.value)} className="w-48">
              <option value="">{allStaff ? 'All staff' : 'Choose…'}</option>
              {staff.map((s) => (
                <option key={s.membership_id} value={s.membership_id}>
                  {staffName(s)}
                </option>
              ))}
            </Select>
          </Field>
          {canExport && rows.length > 0 && (
            <Button
              variant="ghost"
              onClick={() =>
                downloadCsv(
                  `attendance-${month}.csv`,
                  ['Employee', 'Email', 'Scheduled days', 'Present', 'Late', 'Absent', 'Leave', 'Hours worked', 'Approved OT hours', 'Attendance %'],
                  rows.map(({ member, s }) => [
                    staffName(member),
                    member.email,
                    s.scheduled_days,
                    s.present,
                    s.late,
                    s.absent,
                    s.leave,
                    (s.worked_minutes / 60).toFixed(1),
                    (s.approved_overtime_minutes / 60).toFixed(1),
                    s.attendance_pct,
                  ]),
                )
              }
            >
              Export CSV
            </Button>
          )}
        </div>
      </div>
      {error && <div className="bg-danger/10 text-danger text-xs p-3">{error}</div>}
      {loading ? (
        <p className="p-3 text-muted text-xs">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="p-3 text-muted text-xs">{allStaff || who ? 'No staff to report on.' : 'Choose an employee to see their month.'}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs tabular-nums">
            <thead className="text-muted border-b border-border">
              <tr>
                <th className="p-2.5 font-semibold">Employee</th>
                <th className="p-2.5 font-semibold text-right">Present</th>
                <th className="p-2.5 font-semibold text-right">Late</th>
                <th className="p-2.5 font-semibold text-right">Absent</th>
                <th className="p-2.5 font-semibold text-right">Leave</th>
                <th className="p-2.5 font-semibold text-right">Worked</th>
                <th className="p-2.5 font-semibold text-right">Attendance</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ member, s }) => (
                <tr key={member.membership_id} className="border-b border-border/60 last:border-0">
                  <td className="p-2.5 font-semibold">{staffName(member)}</td>
                  <td className="p-2.5 text-right">
                    {s.present}/{s.scheduled_days}
                  </td>
                  <td className="p-2.5 text-right text-warn">{s.late}</td>
                  <td className="p-2.5 text-right text-danger">{s.absent}</td>
                  <td className="p-2.5 text-right">{s.leave}</td>
                  <td className="p-2.5 text-right">{hours(s.worked_minutes)}</td>
                  <td className="p-2.5 text-right font-bold">{s.attendance_pct != null ? `${s.attendance_pct}%` : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

function History({ staff, canExport }: { staff: StaffRow[]; canExport: boolean }) {
  const supabase = usePortalSupabase();
  const today = new Date();
  const weekAgo = new Date(today);
  weekAgo.setDate(weekAgo.getDate() - 6);
  const [from, setFrom] = useState(iso(weekAgo));
  const [to, setTo] = useState(iso(today));
  const [who, setWho] = useState('');
  const [rows, setRows] = useState<HistoryRow[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void supabase
      .rpc('attendance_history', { p_from: from, p_to: to, p_membership_id: who || null })
      .then(({ data, error: e }) => {
        if (e) setError(e.message);
        else {
          setError(null);
          setRows((data ?? []) as HistoryRow[]);
        }
      });
  }, [supabase, from, to, who]);

  return (
    <Card className="p-0 overflow-hidden">
      <div className="flex flex-wrap items-end justify-between gap-3 p-3 border-b border-border">
        <h3 className="font-bold text-sm">Attendance history</h3>
        <div className="flex flex-wrap items-end gap-2">
          <Field label="From">
            <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="w-36" />
          </Field>
          <Field label="To">
            <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="w-36" />
          </Field>
          <Field label="Employee">
            <Select value={who} onChange={(e) => setWho(e.target.value)} className="w-44">
              <option value="">Everyone</option>
              {staff.map((s) => (
                <option key={s.membership_id} value={s.membership_id}>
                  {staffName(s)}
                </option>
              ))}
            </Select>
          </Field>
          {canExport && rows.length > 0 && (
            <Button
              variant="ghost"
              onClick={() =>
                downloadCsv(
                  `attendance-history-${from}-to-${to}.csv`,
                  ['Date', 'Employee', 'Email', 'Clock in', 'Clock out', 'Status', 'Late min', 'Worked min', 'Overtime min', 'Source'],
                  rows.map((r) => [
                    r.business_date,
                    staffName(r),
                    r.email,
                    r.clock_in,
                    r.clock_out,
                    r.status,
                    r.late_minutes,
                    r.worked_minutes,
                    r.overtime_minutes,
                    r.source,
                  ]),
                )
              }
            >
              Export CSV
            </Button>
          )}
        </div>
      </div>
      {error && <div className="bg-danger/10 text-danger text-xs p-3">{error}</div>}
      {rows.length === 0 ? (
        <p className="p-3 text-muted text-xs">No attendance recorded in this range.</p>
      ) : (
        <div className="max-h-[26rem] overflow-y-auto">
          <table className="w-full text-left text-xs tabular-nums">
            <thead className="text-muted border-b border-border sticky top-0 bg-surface">
              <tr>
                <th className="p-2.5 font-semibold">Date</th>
                <th className="p-2.5 font-semibold">Employee</th>
                <th className="p-2.5 font-semibold">In – out</th>
                <th className="p-2.5 font-semibold">Status</th>
                <th className="p-2.5 font-semibold text-right">Worked</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-b border-border/60 last:border-0">
                  <td className="p-2.5">{r.business_date}</td>
                  <td className="p-2.5 font-semibold">{staffName(r)}</td>
                  <td className="p-2.5">
                    {time(r.clock_in)} – {time(r.clock_out)}
                  </td>
                  <td className="p-2.5 capitalize">
                    {r.status?.replace('_', ' ') ?? '—'}
                    {r.late_minutes > 0 ? <span className="text-warn"> · {r.late_minutes}m late</span> : null}
                  </td>
                  <td className="p-2.5 text-right">{hours(r.worked_minutes)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

function Corrections({
  staff,
  nameOf,
  canRequest,
  canCorrect,
  canApprove,
}: {
  staff: StaffRow[];
  nameOf: (id: string) => string;
  canRequest: boolean;
  canCorrect: boolean;
  canApprove: boolean;
}) {
  const supabase = usePortalSupabase();
  const [who, setWho] = useState('');
  const [date, setDate] = useState(iso(new Date()));
  const [inAt, setInAt] = useState('');
  const [outAt, setOutAt] = useState('');
  const [reason, setReason] = useState('');
  const [list, setList] = useState<Correction[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(async () => {
    const { data } = await supabase
      .from('attendance_corrections')
      .select(
        'id, membership_id, business_date, requested_clock_in, requested_clock_out, reason, status, requested_by_email, reviewed_by_email, review_note, created_at',
      )
      .order('created_at', { ascending: false })
      .limit(30);
    setList((data ?? []) as Correction[]);
  }, [supabase]);

  useEffect(() => {
    void load();
  }, [load]);

  async function submit(direct: boolean) {
    if (!who || !reason.trim() || (!inAt && !outAt)) {
      setError('Choose the employee, the day, at least one time, and a reason.');
      return;
    }
    setBusy(true);
    setError(null);
    setNote(null);
    const args = {
      p_membership_id: who,
      p_business_date: date,
      p_clock_in: toTs(date, inAt),
      p_clock_out: toTs(date, outAt),
      p_reason: reason.trim(),
    };
    const { error: e } = await supabase.rpc(direct ? 'correct_attendance' : 'request_attendance_correction', args);
    setBusy(false);
    if (e) {
      setError(e.message);
      return;
    }
    setNote(direct ? 'Attendance corrected.' : 'Correction requested — it will apply once approved.');
    setInAt('');
    setOutAt('');
    setReason('');
    await load();
  }

  async function review(c: Correction, approve: boolean) {
    const reviewNote = approve ? '' : (window.prompt('Why is this being rejected?') ?? '');
    setBusy(true);
    setError(null);
    const { error: e } = await supabase.rpc('review_attendance_correction', {
      p_correction_id: c.id,
      p_approve: approve,
      p_note: reviewNote || null,
    });
    setBusy(false);
    if (e) {
      setError(
        /cannot_review_own_request/.test(e.message) ? "You can't approve a correction you requested yourself." : e.message,
      );
      return;
    }
    await load();
  }

  return (
    <Card>
      <h3 className="font-bold text-sm">Attendance corrections</h3>
      {(canRequest || canCorrect) && (
        <div className="mt-3 grid grid-cols-2 sm:grid-cols-6 gap-3 items-end">
          <Field label="Employee">
            <Select value={who} onChange={(e) => setWho(e.target.value)}>
              <option value="">Choose…</option>
              {staff.map((s) => (
                <option key={s.membership_id} value={s.membership_id}>
                  {staffName(s)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Day">
            <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </Field>
          <Field label="Clock in">
            <Input type="time" value={inAt} onChange={(e) => setInAt(e.target.value)} />
          </Field>
          <Field label="Clock out">
            <Input type="time" value={outAt} onChange={(e) => setOutAt(e.target.value)} />
          </Field>
          <Field label="Reason">
            <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Forgot to clock out" />
          </Field>
          <div className="flex gap-1.5">
            {canCorrect && (
              <Button disabled={busy} onClick={() => submit(true)}>
                Correct now
              </Button>
            )}
            {canRequest && (
              <Button variant={canCorrect ? 'ghost' : 'primary'} disabled={busy} onClick={() => submit(false)}>
                Request
              </Button>
            )}
          </div>
        </div>
      )}
      {error && <p className="text-danger text-xs mt-2">{error}</p>}
      {note && <p className="text-ok text-xs mt-2">{note}</p>}
      {list.length > 0 && (
        <div className="mt-4 overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="text-muted border-b border-border">
              <tr>
                <th className="py-2 font-semibold">Employee · day</th>
                <th className="py-2 font-semibold">Requested times</th>
                <th className="py-2 font-semibold">Reason</th>
                <th className="py-2 font-semibold">Status</th>
                <th className="py-2" />
              </tr>
            </thead>
            <tbody>
              {list.map((c) => (
                <tr key={c.id} className="border-b border-border/60 last:border-0 align-top">
                  <td className="py-2">
                    <div className="font-semibold">{nameOf(c.membership_id)}</div>
                    <div className="text-muted">{c.business_date}</div>
                  </td>
                  <td className="py-2 tabular-nums">
                    {time(c.requested_clock_in)} – {time(c.requested_clock_out)}
                  </td>
                  <td className="py-2 text-muted max-w-[220px]">
                    {c.reason}
                    <div className="text-[10px]">
                      {c.requested_by_email ?? '—'} · {formatDateTime(c.created_at)}
                    </div>
                  </td>
                  <td className="py-2 capitalize">
                    <span className={c.status === 'approved' ? 'text-ok' : c.status === 'rejected' ? 'text-danger' : 'text-warn'}>
                      {c.status}
                    </span>
                    {c.review_note ? <div className="text-muted normal-case">{c.review_note}</div> : null}
                  </td>
                  <td className="py-2 text-right whitespace-nowrap">
                    {canApprove && c.status === 'pending' && (
                      <>
                        <Button disabled={busy} onClick={() => review(c, true)}>
                          Approve
                        </Button>
                        <Button variant="danger" className="ml-1.5" disabled={busy} onClick={() => review(c, false)}>
                          Reject
                        </Button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
