'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { usePortalSupabase } from '@/components/PortalProvider';
import { Button, Card, Field, Input, Select } from '@/components/ui';
import { formatDateTime } from '@/lib/format';

type Member = { id: string; full_name: string | null; email: string; role: string };

export type Shift = {
  id: string;
  membership_id: string;
  starts_at: string;
  ends_at: string;
  role_label: string | null;
  notes: string | null;
};

export type Attendance = {
  id: string;
  membership_id: string;
  clock_in: string;
  clock_out: string | null;
  note: string | null;
};

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

function hhmm(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

function hoursBetween(a: string, b: string): string {
  return ((new Date(b).getTime() - new Date(a).getTime()) / 3.6e6).toFixed(1);
}

export function SchedulingClient({
  slug,
  weekOffset,
  weekStartISO,
  members,
  shifts,
  attendance,
}: {
  slug: string;
  weekOffset: number;
  weekStartISO: string;
  members: Member[];
  shifts: Shift[];
  attendance: Attendance[];
}) {
  const router = useRouter();
  const supabase = usePortalSupabase();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const weekStart = useMemo(() => new Date(weekStartISO), [weekStartISO]);
  const memberName = (id: string) => {
    const m = members.find((x) => x.id === id);
    return m ? (m.full_name ?? m.email) : 'Unknown';
  };

  const [memberId, setMemberId] = useState('');
  const [day, setDay] = useState('0');
  const [from, setFrom] = useState('09:00');
  const [to, setTo] = useState('17:00');
  const [roleLabel, setRoleLabel] = useState('');

  const byDay = useMemo(() => {
    const g: Shift[][] = [[], [], [], [], [], [], []];
    for (const s of shifts) {
      const idx = Math.floor(
        (new Date(s.starts_at).getTime() - weekStart.getTime()) / 8.64e7,
      );
      if (idx >= 0 && idx < 7) g[idx].push(s);
    }
    return g;
  }, [shifts, weekStart]);

  const openClock = useMemo(
    () => new Set(attendance.filter((a) => !a.clock_out).map((a) => a.membership_id)),
    [attendance],
  );

  const weekLabel = useMemo(() => {
    const end = new Date(weekStart);
    end.setDate(end.getDate() + 6);
    const f = (d: Date) => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    return `${f(weekStart)} – ${f(end)}`;
  }, [weekStart]);

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

  async function addShift(e: React.FormEvent) {
    e.preventDefault();
    if (!memberId) {
      setError('Pick a staff member.');
      return;
    }
    const base = new Date(weekStart);
    base.setDate(base.getDate() + Number(day));
    const starts = new Date(base);
    const [sh, sm] = from.split(':').map(Number);
    starts.setHours(sh, sm, 0, 0);
    const ends = new Date(base);
    const [eh, em] = to.split(':').map(Number);
    ends.setHours(eh, em, 0, 0);
    if (ends <= starts) {
      setError('End time must be after the start time.');
      return;
    }
    const ok = await run(() =>
      supabase.from('shifts').insert({
        membership_id: memberId,
        starts_at: starts.toISOString(),
        ends_at: ends.toISOString(),
        role_label: roleLabel.trim() || null,
      }),
    );
    if (ok) setRoleLabel('');
  }

  return (
    <div className="space-y-8">
      {error && (
        <div className="rounded border border-danger/40 bg-danger/10 text-danger p-3 text-xs">
          {error}
        </div>
      )}

      {/* ── Rota ── */}
      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="font-bold text-sm">Week of {weekLabel}</h2>
          <div className="flex gap-1.5 text-xs">
            <a href={`/r/${slug}/scheduling?w=${weekOffset - 1}`} className="px-2 py-1 rounded border border-border font-semibold">
              ← prev
            </a>
            {weekOffset !== 0 && (
              <a href={`/r/${slug}/scheduling`} className="px-2 py-1 rounded border border-border font-semibold">
                this week
              </a>
            )}
            <a href={`/r/${slug}/scheduling?w=${weekOffset + 1}`} className="px-2 py-1 rounded border border-border font-semibold">
              next →
            </a>
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-7 gap-2">
          {DAYS.map((d, i) => {
            const date = new Date(weekStart);
            date.setDate(date.getDate() + i);
            return (
              <div key={d} className="rounded-lg border border-border bg-surface p-2 min-h-[7rem]">
                <div className="text-[11px] font-bold text-muted mb-1.5">
                  {d} {date.getDate()}
                </div>
                <div className="space-y-1.5">
                  {byDay[i].length === 0 ? (
                    <div className="text-[11px] text-muted/60">—</div>
                  ) : (
                    byDay[i].map((s) => (
                      <div key={s.id} className="rounded bg-main px-1.5 py-1 text-[11px] group">
                        <div className="font-semibold truncate">{memberName(s.membership_id)}</div>
                        <div className="text-muted">
                          {hhmm(s.starts_at)}–{hhmm(s.ends_at)}
                        </div>
                        {s.role_label && <div className="text-muted truncate">{s.role_label}</div>}
                        <button
                          className="text-danger opacity-0 group-hover:opacity-100 transition-opacity"
                          disabled={busy}
                          onClick={() => run(() => supabase.from('shifts').delete().eq('id', s.id))}
                        >
                          remove
                        </button>
                      </div>
                    ))
                  )}
                </div>
              </div>
            );
          })}
        </div>

        <Card>
          <h3 className="font-bold text-sm mb-3">Add a shift</h3>
          <form onSubmit={addShift} className="grid grid-cols-1 sm:grid-cols-6 gap-3 items-end">
            <Field label="Staff">
              <Select value={memberId} onChange={(e) => setMemberId(e.target.value)}>
                <option value="">— pick —</option>
                {members.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.full_name ?? m.email}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Day">
              <Select value={day} onChange={(e) => setDay(e.target.value)}>
                {DAYS.map((d, i) => (
                  <option key={d} value={i}>
                    {d}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="From">
              <Input type="time" value={from} onChange={(e) => setFrom(e.target.value)} />
            </Field>
            <Field label="To">
              <Input type="time" value={to} onChange={(e) => setTo(e.target.value)} />
            </Field>
            <Field label="Role (optional)">
              <Input value={roleLabel} onChange={(e) => setRoleLabel(e.target.value)} placeholder="Line cook" />
            </Field>
            <Button type="submit" disabled={busy}>
              Add
            </Button>
          </form>
        </Card>
      </section>

      {/* ── Attendance ── */}
      <section className="space-y-3">
        <h2 className="font-bold text-sm">Attendance log</h2>

        <Card>
          <h3 className="font-bold text-sm mb-3">Record clock in / out</h3>
          <div className="flex flex-wrap gap-2">
            {members.map((m) => {
              const isIn = openClock.has(m.id);
              return (
                <Button
                  key={m.id}
                  variant={isIn ? 'danger' : 'ghost'}
                  disabled={busy}
                  onClick={() =>
                    isIn
                      ? run(() =>
                          supabase
                            .from('attendance')
                            .update({ clock_out: new Date().toISOString() })
                            .eq('membership_id', m.id)
                            .is('clock_out', null),
                        )
                      : run(() => supabase.from('attendance').insert({ membership_id: m.id }))
                  }
                >
                  {m.full_name ?? m.email} · {isIn ? 'clock out' : 'clock in'}
                </Button>
              );
            })}
          </div>
        </Card>

        <Card className="p-0 overflow-hidden">
          <table className="w-full text-left text-xs">
            <thead className="text-muted border-b border-border">
              <tr>
                <th className="p-3 font-semibold">Staff</th>
                <th className="p-3 font-semibold">In</th>
                <th className="p-3 font-semibold">Out</th>
                <th className="p-3 font-semibold text-right">Hours</th>
              </tr>
            </thead>
            <tbody>
              {attendance.length === 0 ? (
                <tr>
                  <td colSpan={4} className="p-3 text-muted">
                    No attendance recorded yet.
                  </td>
                </tr>
              ) : (
                attendance.map((a) => (
                  <tr key={a.id} className="border-b border-border/60 last:border-0">
                    <td className="p-3 font-semibold">{memberName(a.membership_id)}</td>
                    <td className="p-3 text-muted">{formatDateTime(a.clock_in)}</td>
                    <td className="p-3 text-muted">
                      {a.clock_out ? formatDateTime(a.clock_out) : <span className="text-ok">on shift</span>}
                    </td>
                    <td className="p-3 text-right font-mono">
                      {a.clock_out ? hoursBetween(a.clock_in, a.clock_out) : '—'}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </Card>
      </section>
    </div>
  );
}
