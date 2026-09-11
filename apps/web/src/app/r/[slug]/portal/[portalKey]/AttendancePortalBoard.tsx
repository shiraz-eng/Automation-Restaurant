'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { usePortalSupabase } from '@/components/PortalProvider';

export type RosterRow = {
  membership_id: string;
  full_name: string | null;
  role: string;
  status: string;
  clock_in: string | null;
  clock_out: string | null;
  late_minutes: number;
};

const STATUS_TONE: Record<string, string> = {
  present: 'text-ok',
  late: 'text-warn',
  early_departure: 'text-warn',
  incomplete: 'text-warn',
  absent: 'text-danger',
  leave: 'text-muted',
  off: 'text-muted',
  not_marked: 'text-muted',
};
const MARKS: [string, string][] = [
  ['present', 'Present'],
  ['late', 'Late'],
  ['absent', 'Absent'],
  ['leave', 'Leave'],
];

function hhmm(iso: string | null) {
  if (!iso) return '—';
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
function today() {
  return new Date().toISOString().slice(0, 10);
}

export function AttendancePortalBoard({
  initialRoster,
  canMark,
  canCheckIn,
}: {
  initialRoster: RosterRow[];
  canMark: boolean;
  canCheckIn: boolean;
}) {
  const router = useRouter();
  const supabase = usePortalSupabase();
  const [roster, setRoster] = useState<RosterRow[]>(initialRoster);
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const { data } = await supabase.rpc('attendance_roster', {});
    if (data) setRoster(data as RosterRow[]);
  }, [supabase]);

  useEffect(() => {
    const ch = supabase
      .channel('attendance-portal')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'attendance' }, () => load())
      .subscribe();
    return () => {
      supabase.removeChannel(ch);
    };
  }, [supabase, load]);

  async function run(
    key: string,
    fn: () => PromiseLike<{ error: { message: string } | null }>,
  ) {
    setBusy(key);
    setError(null);
    const { error: e } = await fn();
    setBusy(null);
    if (e) setError(e.message);
    await load();
    router.refresh();
  }

  const shown = useMemo(
    () =>
      roster.filter(
        (r) => !q.trim() || (r.full_name ?? '').toLowerCase().includes(q.trim().toLowerCase()),
      ),
    [roster, q],
  );
  const summary = useMemo(() => {
    const c = { present: 0, late: 0, absent: 0, leave: 0, not_marked: 0 };
    for (const r of roster) {
      if (r.status === 'present' || r.status === 'early_departure' || r.status === 'incomplete') c.present += 1;
      else if (r.status === 'late') c.late += 1;
      else if (r.status === 'absent') c.absent += 1;
      else if (r.status === 'leave' || r.status === 'off') c.leave += 1;
      else c.not_marked += 1;
    }
    return c;
  }, [roster]);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-center">
        {(
          [
            ['Present', summary.present, 'text-ok'],
            ['Late', summary.late, 'text-warn'],
            ['Absent', summary.absent, 'text-danger'],
            ['Not marked', summary.not_marked, 'text-muted'],
          ] as const
        ).map(([label, n, tone]) => (
          <div key={label} className="rounded-lg border border-border bg-surface p-3">
            <div className={`text-2xl font-black ${tone}`}>{n}</div>
            <div className="text-[11px] text-muted">{label}</div>
          </div>
        ))}
      </div>

      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Find staff…"
        className="w-full rounded border border-border bg-surface px-3 py-2 text-sm outline-none focus:border-primary"
      />

      {error && <p className="text-danger text-sm">{error}</p>}

      <div className="rounded-lg border border-border bg-surface divide-y divide-border">
        {shown.length === 0 ? (
          <p className="p-4 text-muted text-xs">No staff.</p>
        ) : (
          shown.map((r) => (
            <div key={r.membership_id} className="p-3">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="font-semibold text-sm truncate">{r.full_name ?? '—'}</div>
                  <div className="text-[11px] text-muted capitalize">
                    {r.role} ·{' '}
                    <span className={STATUS_TONE[r.status] ?? ''}>
                      {r.status.replace('_', ' ')}
                    </span>
                    {r.late_minutes > 0 ? ` · ${r.late_minutes}m late` : ''}
                  </div>
                </div>
                <div className="text-[11px] text-muted text-right shrink-0">
                  <div>in {hhmm(r.clock_in)}</div>
                  <div>out {hhmm(r.clock_out)}</div>
                </div>
              </div>

              <div className="flex flex-wrap gap-1.5 mt-2">
                {canCheckIn && !r.clock_in && (
                  <button
                    disabled={busy === r.membership_id}
                    onClick={() =>
                      run(r.membership_id, () =>
                        supabase.rpc('attendance_check_in', { p_membership_id: r.membership_id }),
                      )
                    }
                    className="rounded bg-primary text-primary-fg font-semibold px-3 py-1.5 text-xs"
                  >
                    Check in
                  </button>
                )}
                {canCheckIn && r.clock_in && !r.clock_out && (
                  <button
                    disabled={busy === r.membership_id}
                    onClick={() =>
                      run(r.membership_id, () =>
                        supabase.rpc('attendance_check_out', { p_membership_id: r.membership_id }),
                      )
                    }
                    className="rounded border border-border font-semibold px-3 py-1.5 text-xs"
                  >
                    Check out
                  </button>
                )}
                {canMark &&
                  MARKS.map(([s, label]) => (
                    <button
                      key={s}
                      disabled={busy === r.membership_id}
                      onClick={() =>
                        run(r.membership_id, () =>
                          supabase.rpc('attendance_mark', {
                            p_membership_id: r.membership_id,
                            p_business_date: today(),
                            p_status: s,
                            p_note: null,
                          }),
                        )
                      }
                      className="rounded border border-border px-2 py-1 text-[11px] capitalize"
                    >
                      {label}
                    </button>
                  ))}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
