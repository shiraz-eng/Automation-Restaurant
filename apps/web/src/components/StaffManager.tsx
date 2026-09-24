'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { usePortal, usePortalSupabase } from '@/components/PortalProvider';
import { Button, Card, Field, Input, Select } from '@/components/ui';
import { ROLE_LABELS, type StaffRole } from '@/lib/portals';

type Member = {
  id: string;
  email: string;
  full_name: string | null;
  role: string;
  status: string;
  created_at: string;
  shift_start_time?: string | null;
};

/** Postgres `time` comes back as "HH:MM:SS"; <input type="time"> needs "HH:MM". */
function hhmm(t: string | null | undefined): string {
  return t ? t.slice(0, 5) : '';
}

const INVITABLE: StaffRole[] = [
  'manager',
  'cashier',
  'chef',
  'waiter',
  'host',
  'hr',
  'accountant',
  'delivery',
];
const ALL_ROLES: StaffRole[] = ['owner', ...INVITABLE];
const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

export function StaffManager({ staff }: { staff: Member[] }) {
  const router = useRouter();
  const { slug } = usePortal();
  const supabase = usePortalSupabase();

  const [fullName, setFullName] = useState('');
  const [role, setRole] = useState<StaffRole>('waiter');
  const [shiftStartTime, setShiftStartTime] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [shiftDrafts, setShiftDrafts] = useState<Record<string, string>>({});

  async function changeRole(m: Member, nextRole: StaffRole) {
    if (nextRole === m.role) return;
    setSavingId(m.id);
    setError(null);
    setNotice(null);
    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      const res = await fetch(`${API}/api/staff/access`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session?.access_token ?? ''}`,
        },
        body: JSON.stringify({ slug, membership_id: m.id, role: nextRole }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(body.message ?? body.error ?? 'Could not change the role.');
        return;
      }
      setNotice(`${m.email} is now ${ROLE_LABELS[nextRole]}.`);
      router.refresh();
    } catch {
      setError('Network error — try again.');
    } finally {
      setSavingId(null);
    }
  }

  async function add(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setNotice(null);
    if (!fullName.trim()) {
      setError('Give this person a name.');
      return;
    }
    setBusy(true);
    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      // No email/password to type here — the account is created with a
      // generated login (same pattern as a kiosk portal's), shown once
      // below so it can be handed to the person directly.
      const res = await fetch(`${API}/api/staff`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session?.access_token ?? ''}`,
        },
        body: JSON.stringify({
          slug,
          full_name: fullName.trim(),
          role,
          ...(shiftStartTime ? { shift_start_time: shiftStartTime } : {}),
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(body.message ?? body.error ?? 'Could not create the account.');
        return;
      }
      setNotice(
        `${fullName.trim()} added as ${ROLE_LABELS[role]}.\n  Email:    ${body.login.email}\n  Password: ${body.login.password}\n(Shown once — copy it now.)`,
      );
      setFullName('');
      setShiftStartTime('');
      router.refresh();
    } catch {
      setError('Network error — try again.');
    } finally {
      setBusy(false);
    }
  }

  async function saveShiftStart(m: Member) {
    const value = shiftDrafts[m.id] ?? hhmm(m.shift_start_time);
    setSavingId(m.id);
    setError(null);
    setNotice(null);
    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      const res = await fetch(`${API}/api/staff/${m.id}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session?.access_token ?? ''}`,
        },
        body: JSON.stringify({ slug, shift_start_time: value || null }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(body.message ?? body.error ?? 'Could not update the shift start time.');
        return;
      }
      setNotice(`Updated ${m.full_name || m.email}'s shift start time.`);
      router.refresh();
    } catch {
      setError('Network error — try again.');
    } finally {
      setSavingId(null);
    }
  }

  return (
    <div className="space-y-6">
      <Card>
        <h2 className="font-bold text-sm mb-3">Add staff</h2>
        <p className="text-muted text-xs mb-3">
          Creates a login in this restaurant&apos;s project — email and password are generated
          for you and shown once below. They sign in at <code>/r/{slug}/login</code> and land in
          their own portal.
        </p>
        <form onSubmit={add} className="grid grid-cols-1 sm:grid-cols-4 gap-3 items-end">
          <Field label="Name">
            <Input value={fullName} onChange={(e) => setFullName(e.target.value)} />
          </Field>
          <Field label="Role">
            <Select value={role} onChange={(e) => setRole(e.target.value as StaffRole)}>
              {INVITABLE.map((r) => (
                <option key={r} value={r}>
                  {ROLE_LABELS[r]}
                </option>
              ))}
            </Select>
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
        {notice && <p className="text-ok text-xs mt-2 font-mono whitespace-pre-wrap">{notice}</p>}
      </Card>

      <Card className="p-0 overflow-hidden">
        <table className="w-full text-left text-xs">
          <thead className="text-muted border-b border-border">
            <tr>
              <th className="p-3 font-semibold">Name</th>
              <th className="p-3 font-semibold">Email</th>
              <th className="p-3 font-semibold">Role</th>
              <th className="p-3 font-semibold">Shift start</th>
              <th className="p-3 font-semibold">Status</th>
            </tr>
          </thead>
          <tbody>
            {staff.length === 0 ? (
              <tr>
                <td colSpan={5} className="p-3 text-muted">
                  No staff yet.
                </td>
              </tr>
            ) : (
              staff.map((m) => (
                <tr key={m.id} className="border-b border-border/60">
                  <td className="p-3 font-semibold">{m.full_name ?? '—'}</td>
                  <td className="p-3 text-muted">{m.email}</td>
                  <td className="p-3">
                    <Select
                      value={m.role}
                      disabled={savingId === m.id}
                      onChange={(e) => changeRole(m, e.target.value as StaffRole)}
                      className="text-xs py-1"
                    >
                      {ALL_ROLES.map((r) => (
                        <option key={r} value={r}>
                          {ROLE_LABELS[r]}
                        </option>
                      ))}
                    </Select>
                  </td>
                  <td className="p-3">
                    <div className="flex items-center gap-1.5">
                      <input
                        type="time"
                        value={shiftDrafts[m.id] ?? hhmm(m.shift_start_time)}
                        disabled={savingId === m.id}
                        onChange={(e) => setShiftDrafts((d) => ({ ...d, [m.id]: e.target.value }))}
                        className="rounded border border-border bg-surface px-1.5 py-1 text-xs outline-none focus:border-primary"
                      />
                      {shiftDrafts[m.id] !== undefined && shiftDrafts[m.id] !== hhmm(m.shift_start_time) && (
                        <button
                          type="button"
                          disabled={savingId === m.id}
                          onClick={() => saveShiftStart(m)}
                          className="text-primary font-semibold hover:underline shrink-0"
                        >
                          Save
                        </button>
                      )}
                    </div>
                  </td>
                  <td className="p-3">
                    <span className={m.status === 'active' ? 'text-ok' : 'text-muted'}>
                      {m.status}
                    </span>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </Card>
    </div>
  );
}
