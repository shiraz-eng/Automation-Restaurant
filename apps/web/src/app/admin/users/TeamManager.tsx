'use client';

import { useEffect, useState } from 'react';
import { createControlPlaneBrowserClient } from '@/lib/supabase/control-plane-client';
import { AdminButton, AdminCard, AdminField, AdminInput, AdminBadge } from '../_components/ui';

const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

type Admin = {
  id: string;
  email: string;
  role: string;
  extra_permissions: string[];
  status: 'invited' | 'active' | 'disabled';
  invited_at: string;
  accepted_at: string | null;
};
type Role = { key: string; name: string; permissions: string[] };
type Catalog = { key: string; grp: string; label: string };

function InviteForm({ roles, catalog, onDone }: { roles: Role[]; catalog: Catalog[]; onDone: () => void }) {
  const supabase = createControlPlaneBrowserClient();
  const [email, setEmail] = useState('');
  const [role, setRole] = useState(roles[0]?.key ?? '');
  const [extra, setExtra] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function toggleExtra(key: string) {
    setExtra((e) => (e.includes(key) ? e.filter((k) => k !== key) : [...e, key]));
  }

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      const res = await fetch(`${API}/api/admin/team/invite`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session?.access_token ?? ''}` },
        body: JSON.stringify({ email, role, extra_permissions: extra }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || body.ok === false) return setError(body.message ?? body.error ?? 'Invite failed');
      setEmail('');
      setExtra([]);
      onDone();
    } catch {
      setError('Network error — try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <AdminCard className="space-y-3">
      <div className="font-bold text-sm">Invite a platform admin</div>
      <div className="grid grid-cols-2 gap-3">
        <AdminField label="Email">
          <AdminInput type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="teammate@company.com" />
        </AdminField>
        <AdminField label="Role">
          <select
            value={role}
            onChange={(e) => setRole(e.target.value)}
            className="w-full rounded-lg border border-white/15 bg-ink/80 px-2.5 py-1.5 text-xs text-ink-fg outline-none focus:border-gold/60"
          >
            {roles.map((r) => (
              <option key={r.key} value={r.key}>
                {r.name}
              </option>
            ))}
          </select>
        </AdminField>
      </div>
      <div>
        <div className="text-[11px] font-semibold text-ink-muted mb-1.5">Extra permissions (on top of the role)</div>
        <div className="flex flex-wrap gap-3">
          {catalog.map((c) => (
            <label key={c.key} className="flex items-center gap-1.5 text-xs">
              <input type="checkbox" checked={extra.includes(c.key)} onChange={() => toggleExtra(c.key)} />
              {c.label}
            </label>
          ))}
        </div>
      </div>
      {error && <p className="text-red-400 text-xs">{error}</p>}
      <AdminButton onClick={submit} disabled={busy || !email.trim() || !role}>
        {busy ? 'Sending…' : 'Send invite'}
      </AdminButton>
    </AdminCard>
  );
}

export function TeamManager() {
  const supabase = createControlPlaneBrowserClient();
  const [admins, setAdmins] = useState<Admin[] | null>(null);
  const [roles, setRoles] = useState<Role[]>([]);
  const [catalog, setCatalog] = useState<Catalog[]>([]);
  const [inviting, setInviting] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  async function refresh() {
    const {
      data: { session },
    } = await supabase.auth.getSession();
    const headers = { Authorization: `Bearer ${session?.access_token ?? ''}` };
    const [teamRes, catalogRes] = await Promise.all([
      fetch(`${API}/api/admin/team`, { headers }).then((r) => r.json()),
      supabase.from('platform_permission_catalog').select('key, grp, label'),
    ]);
    setAdmins(teamRes.admins ?? []);
    setRoles(teamRes.roles ?? []);
    setCatalog((catalogRes.data as Catalog[]) ?? []);
    setInviting(false);
  }

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function setStatus(id: string, status: 'active' | 'disabled') {
    setBusyId(id);
    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      await fetch(`${API}/api/admin/team/${id}/${status === 'active' ? 'reactivate' : 'disable'}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${session?.access_token ?? ''}` },
      });
      refresh();
    } catch {
      // no error state on this row-level action; the row simply stays as-is
    } finally {
      setBusyId(null);
    }
  }

  if (admins === null) return <p className="text-ink-muted text-xs">Loading…</p>;

  return (
    <div className="space-y-3">
      {inviting ? (
        <InviteForm roles={roles} catalog={catalog} onDone={refresh} />
      ) : (
        <AdminButton variant="ghost" onClick={() => setInviting(true)}>
          + Invite admin
        </AdminButton>
      )}

      {admins.length === 0 ? (
        <AdminCard>No platform admins yet.</AdminCard>
      ) : (
        admins.map((a) => (
          <AdminCard key={a.id} className="flex items-center justify-between gap-3">
            <div>
              <div className="font-bold text-sm flex items-center gap-2">
                {a.email}
                <span className="text-[10px] font-mono text-ink-muted">{a.role}</span>
                <AdminBadge status={a.status} />
              </div>
              <div className="text-ink-muted text-xs">
                {a.extra_permissions.length > 0 ? `+${a.extra_permissions.length} extra permission(s)` : 'Role permissions only'}
              </div>
            </div>
            <div className="flex gap-1.5">
              {a.status === 'disabled' ? (
                <AdminButton disabled={busyId === a.id} onClick={() => setStatus(a.id, 'active')}>
                  Reactivate
                </AdminButton>
              ) : (
                <AdminButton variant="danger" disabled={busyId === a.id} onClick={() => setStatus(a.id, 'disabled')}>
                  Disable
                </AdminButton>
              )}
            </div>
          </AdminCard>
        ))
      )}
    </div>
  );
}
