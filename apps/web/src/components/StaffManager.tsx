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
};

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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [savingId, setSavingId] = useState<string | null>(null);

  async function changeRole(m: Member, nextRole: StaffRole) {
    if (nextRole === m.role) return;
    setSavingId(m.id);
    setError(null);
    setNotice(null);
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
    setSavingId(null);
    if (!res.ok) {
      setError(body.message ?? body.error ?? 'Could not change the role.');
      return;
    }
    setNotice(`${m.email} is now ${ROLE_LABELS[nextRole]}.`);
    router.refresh();
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
      }),
    });
    const body = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) {
      setError(body.message ?? body.error ?? 'Could not create the account.');
      return;
    }
    setNotice(
      `${fullName.trim()} added as ${ROLE_LABELS[role]}.\n  Email:    ${body.login.email}\n  Password: ${body.login.password}\n(Shown once — copy it now.)`,
    );
    setFullName('');
    router.refresh();
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
        <form onSubmit={add} className="grid grid-cols-1 sm:grid-cols-3 gap-3 items-end">
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
          <Button type="submit" disabled={busy}>
            {busy ? 'Adding…' : 'Add'}
          </Button>
        </form>
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
              <th className="p-3 font-semibold">Status</th>
            </tr>
          </thead>
          <tbody>
            {staff.length === 0 ? (
              <tr>
                <td colSpan={4} className="p-3 text-muted">
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
