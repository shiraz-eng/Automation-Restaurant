'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { usePortal, usePortalSupabase } from '@/components/PortalProvider';
import { Button, Card, Field, Input } from '@/components/ui';
import { roleLabel } from '@/lib/portals';

type Member = {
  id: string;
  email: string | null;
  full_name: string | null;
  job_title?: string | null;
  role: string;
  status: string;
  created_at: string;
  shift_start_time?: string | null;
};

/** Postgres `time` comes back as "HH:MM:SS"; <input type="time"> needs "HH:MM". */
function hhmm(t: string | null | undefined): string {
  return t ? t.slice(0, 5) : '';
}

/** What a member does: the typed job title, else (for a sign-in account
 *  such as the owner) their account role. */
function titleOf(m: Member): string {
  return m.job_title || roleLabel(m.role);
}

const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

export function StaffManager({
  staff,
  canAdd,
  canEditShift,
  canRemove = false,
}: {
  staff: Member[];
  /** staff.create — matches POST /api/staff's requirePortalPerm. */
  canAdd: boolean;
  /** staff.update — matches PATCH /api/staff/:id's requirePortalPerm. */
  canEditShift: boolean;
  /** staff.delete — matches DELETE /api/staff/:id's requirePortalPerm. */
  canRemove?: boolean;
}) {
  const router = useRouter();
  const { slug } = usePortal();
  const supabase = usePortalSupabase();

  const [fullName, setFullName] = useState('');
  const [jobTitle, setJobTitle] = useState('');
  const [shiftStartTime, setShiftStartTime] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [shiftDrafts, setShiftDrafts] = useState<Record<string, string>>({});
  const [titleDrafts, setTitleDrafts] = useState<Record<string, string>>({});

  // Removed staff are kept (attendance history points at them) but not listed.
  const visible = staff.filter((m) => m.status !== 'disabled');

  async function call(path: string, method: string, body: Record<string, unknown>) {
    const {
      data: { session },
    } = await supabase.auth.getSession();
    const res = await fetch(`${API}/api/staff${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session?.access_token ?? ''}` },
      body: JSON.stringify({ slug, ...body }),
    });
    const json = await res.json().catch(() => ({}));
    return { ok: res.ok, message: (json.message ?? json.error) as string | undefined };
  }

  async function add(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setNotice(null);
    if (!fullName.trim()) return setError('Give this person a name.');
    if (!jobTitle.trim()) return setError('Type their job, e.g. Waiter.');
    setBusy(true);
    try {
      const r = await call('', 'POST', {
        full_name: fullName.trim(),
        job_title: jobTitle.trim(),
        ...(shiftStartTime ? { shift_start_time: shiftStartTime } : {}),
      });
      if (!r.ok) return setError(r.message ?? 'Could not add this person.');
      setNotice(`${fullName.trim()} added as ${jobTitle.trim()}.`);
      setFullName('');
      setJobTitle('');
      setShiftStartTime('');
      router.refresh();
    } catch {
      setError('Network error — try again.');
    } finally {
      setBusy(false);
    }
  }

  async function saveMember(m: Member, patch: { shift_start_time?: string | null; job_title?: string }, done: string) {
    setSavingId(m.id);
    setError(null);
    setNotice(null);
    try {
      const r = await call(`/${m.id}`, 'PATCH', patch);
      if (!r.ok) return setError(r.message ?? 'Could not save the change.');
      setNotice(done);
      const drop = (d: Record<string, string>) => {
        const next = { ...d };
        delete next[m.id];
        return next;
      };
      setShiftDrafts(drop);
      setTitleDrafts(drop);
      router.refresh();
    } catch {
      setError('Network error — try again.');
    } finally {
      setSavingId(null);
    }
  }

  async function removeMember(m: Member) {
    const name = m.full_name || m.email || 'this person';
    if (!window.confirm(`Remove ${name}? Their attendance history is kept.`)) return;
    setSavingId(m.id);
    setError(null);
    setNotice(null);
    try {
      const r = await call(`/${m.id}`, 'DELETE', {});
      if (!r.ok) return setError(r.message ?? 'Could not remove this staff member.');
      setNotice(`Removed ${name}.`);
      router.refresh();
    } catch {
      setError('Network error — try again.');
    } finally {
      setSavingId(null);
    }
  }

  const cellInput = 'rounded border border-border bg-surface px-1.5 py-1 text-xs outline-none focus:border-primary';

  return (
    <div className="space-y-6">
      {canAdd && (
        <Card>
          <h2 className="font-bold text-sm mb-3">Add staff</h2>
          <p className="text-muted text-xs mb-3">
            Just a name and their job — no email or password. To give someone a screen to work on,
            create a custom portal for them under Portals.
          </p>
          <form onSubmit={add} className="grid grid-cols-1 sm:grid-cols-4 gap-3 items-end">
            <Field label="Name">
              <Input value={fullName} onChange={(e) => setFullName(e.target.value)} />
            </Field>
            <Field label="Job">
              <Input value={jobTitle} maxLength={60} placeholder="e.g. Waiter" onChange={(e) => setJobTitle(e.target.value)} />
            </Field>
            <Field label="Shift start (optional)">
              <Input type="time" value={shiftStartTime} onChange={(e) => setShiftStartTime(e.target.value)} />
            </Field>
            <Button type="submit" disabled={busy}>
              {busy ? 'Adding…' : 'Add'}
            </Button>
          </form>
          <p className="text-muted text-[11px] mt-2">
            Shift start is this person&rsquo;s default expected clock-in time — used to mark them
            late if they check in after it (plus the configured grace period), on any day without
            an explicit shift scheduled. Leave blank if you always schedule shifts instead.
          </p>
          {error && <p className="text-danger text-xs mt-2">{error}</p>}
          {notice && <p className="text-ok text-xs mt-2">{notice}</p>}
        </Card>
      )}
      {!canAdd && (error || notice) && (
        <div className="space-y-1">
          {error && <p className="text-danger text-xs">{error}</p>}
          {notice && <p className="text-ok text-xs">{notice}</p>}
        </div>
      )}

      <Card className="p-0 overflow-x-auto">
        <table className="w-full text-left text-xs">
          <thead className="text-muted border-b border-border">
            <tr>
              <th className="p-3 font-semibold">Name</th>
              <th className="p-3 font-semibold">Job</th>
              <th className="p-3 font-semibold">Shift start</th>
              <th className="p-3 font-semibold">Status</th>
              {canRemove && <th className="p-3" />}
            </tr>
          </thead>
          <tbody>
            {visible.length === 0 ? (
              <tr>
                <td colSpan={canRemove ? 5 : 4} className="p-3 text-muted">
                  No staff yet.
                </td>
              </tr>
            ) : (
              visible.map((m) => {
                const isOwner = m.role === 'owner';
                const titleDraft = titleDrafts[m.id];
                const shiftDraft = shiftDrafts[m.id];
                return (
                  <tr key={m.id} className="border-b border-border/60">
                    <td className="p-3">
                      <div className="font-semibold">{m.full_name ?? '—'}</div>
                      {m.email && <div className="text-muted text-[11px]">{m.email}</div>}
                    </td>
                    <td className="p-3">
                      {canEditShift && !isOwner ? (
                        <div className="flex items-center gap-1.5">
                          <input
                            value={titleDraft ?? titleOf(m)}
                            maxLength={60}
                            disabled={savingId === m.id}
                            onChange={(e) => setTitleDrafts((d) => ({ ...d, [m.id]: e.target.value }))}
                            className={`${cellInput} w-32`}
                          />
                          {titleDraft !== undefined && titleDraft.trim() && titleDraft.trim() !== titleOf(m) && (
                            <button
                              type="button"
                              disabled={savingId === m.id}
                              onClick={() => saveMember(m, { job_title: titleDraft.trim() }, `${m.full_name ?? 'Staff member'} is now ${titleDraft.trim()}.`)}
                              className="text-primary font-semibold hover:underline shrink-0"
                            >
                              Save
                            </button>
                          )}
                        </div>
                      ) : (
                        titleOf(m)
                      )}
                    </td>
                    <td className="p-3">
                      {canEditShift ? (
                        <div className="flex items-center gap-1.5">
                          <input
                            type="time"
                            value={shiftDraft ?? hhmm(m.shift_start_time)}
                            disabled={savingId === m.id}
                            onChange={(e) => setShiftDrafts((d) => ({ ...d, [m.id]: e.target.value }))}
                            className={cellInput}
                          />
                          {shiftDraft !== undefined && shiftDraft !== hhmm(m.shift_start_time) && (
                            <button
                              type="button"
                              disabled={savingId === m.id}
                              onClick={() =>
                                saveMember(m, { shift_start_time: shiftDraft || null }, `Updated the shift start for ${m.full_name ?? 'this person'}.`)
                              }
                              className="text-primary font-semibold hover:underline shrink-0"
                            >
                              Save
                            </button>
                          )}
                        </div>
                      ) : (
                        <span className="text-muted">{hhmm(m.shift_start_time) || '—'}</span>
                      )}
                    </td>
                    <td className="p-3">
                      <span className={m.status === 'active' ? 'text-ok' : 'text-muted'}>{m.status}</span>
                    </td>
                    {canRemove && (
                      <td className="p-3 text-right">
                        {!isOwner && (
                          <button
                            type="button"
                            disabled={savingId === m.id}
                            onClick={() => removeMember(m)}
                            className="text-danger font-semibold hover:underline disabled:opacity-50"
                          >
                            Remove
                          </button>
                        )}
                      </td>
                    )}
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </Card>
    </div>
  );
}
