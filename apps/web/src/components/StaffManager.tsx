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
const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

export function StaffManager({ staff }: { staff: Member[] }) {
  const router = useRouter();
  const { slug } = usePortal();
  const supabase = usePortalSupabase();

  const [email, setEmail] = useState('');
  const [fullName, setFullName] = useState('');
  const [role, setRole] = useState<StaffRole>('waiter');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setOk(null);
    if (!email.trim() || password.length < 8) {
      setError('Email and a password of at least 8 characters are required.');
      return;
    }
    setBusy(true);
    const {
      data: { session },
    } = await supabase.auth.getSession();
    const res = await fetch(`${API}/api/staff`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${session?.access_token ?? ''}`,
      },
      body: JSON.stringify({
        slug,
        email: email.trim(),
        full_name: fullName.trim() || undefined,
        role,
        password,
      }),
    });
    const body = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) {
      setError(body.message ?? body.error ?? 'Could not create the account.');
      return;
    }
    setOk(`${email.trim()} added as ${ROLE_LABELS[role]}.`);
    setEmail('');
    setFullName('');
    setPassword('');
    router.refresh();
  }

  return (
    <div className="space-y-6">
      <Card>
        <h2 className="font-bold text-sm mb-3">Add staff</h2>
        <p className="text-muted text-xs mb-3">
          Creates a login in this restaurant&apos;s project. They sign in at{' '}
          <code>/r/{slug}/login</code> and land in their own portal.
        </p>
        <form onSubmit={add} className="grid grid-cols-1 sm:grid-cols-5 gap-3 items-end">
          <Field label="Name">
            <Input value={fullName} onChange={(e) => setFullName(e.target.value)} />
          </Field>
          <Field label="Email">
            <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
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
          <Field label="Temp password">
            <Input
              type="text"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </Field>
          <Button type="submit" disabled={busy}>
            {busy ? 'Adding…' : 'Add'}
          </Button>
        </form>
        {error && <p className="text-danger text-xs mt-2">{error}</p>}
        {ok && <p className="text-ok text-xs mt-2">{ok}</p>}
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
                  <td className="p-3 capitalize">{m.role}</td>
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
