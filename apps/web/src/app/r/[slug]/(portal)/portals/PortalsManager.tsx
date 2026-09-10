'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { usePortalSupabase } from '@/components/PortalProvider';
import { Button, Card, Field, Input, Select } from '@/components/ui';
import { formatDateTime } from '@/lib/format';

const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

export type Portal = {
  id: string;
  name: string;
  type: string;
  route_key: string;
  status: 'active' | 'disabled';
  permissions: string[];
  last_login_at: string | null;
  created_at: string;
};
export type PermRow = { key: string; grp: string; label: string };

const TYPES = ['checkout', 'kitchen', 'attendance', 'manager', 'custom'] as const;

// Sensible default permission sets per type.
const PRESET: Record<string, string[]> = {
  checkout: ['orders.view', 'payments.view', 'payments.accept'],
  kitchen: ['kitchen.view', 'kitchen.update_status', 'stock.view', 'stock.update'],
  attendance: ['attendance.view', 'attendance.mark'],
  manager: ['orders.view', 'payments.view', 'kitchen.view', 'menu.view', 'stock.view', 'reports.view', 'reviews.view'],
  custom: [],
};

export function PortalsManager({
  slug,
  portals,
  perms,
}: {
  slug: string;
  portals: Portal[];
  perms: PermRow[];
}) {
  const router = useRouter();
  const supabase = usePortalSupabase();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const [name, setName] = useState('');
  const [type, setType] = useState<(typeof TYPES)[number]>('checkout');
  const [selected, setSelected] = useState<Set<string>>(new Set(PRESET.checkout));
  const [editId, setEditId] = useState<string | null>(null);

  const groups = useMemo(() => {
    const m = new Map<string, PermRow[]>();
    for (const p of perms) m.set(p.grp, [...(m.get(p.grp) ?? []), p]);
    return [...m.entries()];
  }, [perms]);

  async function token() {
    const {
      data: { session },
    } = await supabase.auth.getSession();
    return session?.access_token ?? '';
  }

  function pickType(v: (typeof TYPES)[number]) {
    setType(v);
    if (!editId) setSelected(new Set(PRESET[v] ?? []));
  }
  function toggle(key: string) {
    setSelected((s) => {
      const n = new Set(s);
      n.has(key) ? n.delete(key) : n.add(key);
      return n;
    });
  }

  async function createPortal(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setNotice(null);
    if (name.trim().length < 2) return setError('Give the portal a name.');
    setBusy(true);
    const res = await fetch(`${API}/api/portals`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${await token()}` },
      body: JSON.stringify({ slug, name: name.trim(), type, permissions: [...selected] }),
    });
    const body = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) return setError(body.message ?? body.error ?? 'Could not create the portal.');
    setNotice(
      `Portal "${body.portal.name}" created.\n  URL:      ${body.url}\n  Email:    ${body.login.email}\n  Password: ${body.login.password}\n(Shown once — copy it now.)`,
    );
    setName('');
    setSelected(new Set(PRESET[type] ?? []));
    router.refresh();
  }

  async function patch(id: string, changes: Record<string, unknown>) {
    setBusy(true);
    setError(null);
    const res = await fetch(`${API}/api/portals/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${await token()}` },
      body: JSON.stringify({ slug, ...changes }),
    });
    setBusy(false);
    if (!res.ok) {
      const b = await res.json().catch(() => ({}));
      setError(b.message ?? b.error ?? 'Update failed.');
      return;
    }
    setEditId(null);
    router.refresh();
  }

  async function resetPassword(id: string, portalName: string) {
    setBusy(true);
    setError(null);
    setNotice(null);
    const res = await fetch(`${API}/api/portals/${id}/password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${await token()}` },
      body: JSON.stringify({ slug }),
    });
    const b = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) return setError(b.message ?? b.error ?? 'Reset failed.');
    setNotice(`New password for "${portalName}": ${b.password}\n(Shown once.)`);
  }

  async function remove(id: string) {
    setBusy(true);
    const res = await fetch(`${API}/api/portals/${id}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${await token()}` },
      body: JSON.stringify({ slug }),
    });
    setBusy(false);
    if (!res.ok) {
      const b = await res.json().catch(() => ({}));
      setError(b.message ?? b.error ?? 'Delete failed.');
      return;
    }
    router.refresh();
  }

  return (
    <div className="space-y-6">
      {error && (
        <div className="rounded border border-danger/40 bg-danger/10 text-danger p-3 text-xs whitespace-pre-wrap">
          {error}
        </div>
      )}
      {notice && (
        <div className="rounded border border-ok/40 bg-ok/10 text-ok p-3 text-xs font-mono whitespace-pre-wrap">
          {notice}
        </div>
      )}

      <Card>
        <h2 className="font-bold text-sm mb-3">Create portal</h2>
        <form onSubmit={createPortal} className="space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Field label="Portal name">
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Counter 1" />
            </Field>
            <Field label="Type">
              <Select value={type} onChange={(e) => pickType(e.target.value as (typeof TYPES)[number])}>
                {TYPES.map((tp) => (
                  <option key={tp} value={tp}>
                    {tp}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <div>
            <span className="text-muted text-[11px] font-semibold">Permissions</span>
            <div className="mt-1.5 grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-3">
              {groups.map(([grp, rows]) => (
                <div key={grp}>
                  <div className="text-[11px] font-bold text-muted mb-1">{grp}</div>
                  {rows.map((r) => (
                    <label key={r.key} className="flex items-center gap-2 text-xs py-0.5">
                      <input
                        type="checkbox"
                        checked={selected.has(r.key)}
                        onChange={() => toggle(r.key)}
                      />
                      {r.label}
                    </label>
                  ))}
                </div>
              ))}
            </div>
          </div>
          <Button type="submit" disabled={busy}>
            Create portal
          </Button>
        </form>
      </Card>

      <Card className="p-0 overflow-hidden">
        <table className="w-full text-left text-xs">
          <thead className="text-muted border-b border-border">
            <tr>
              <th className="p-3 font-semibold">Portal</th>
              <th className="p-3 font-semibold">Type</th>
              <th className="p-3 font-semibold">URL</th>
              <th className="p-3 font-semibold">Status</th>
              <th className="p-3 font-semibold">Last login</th>
              <th className="p-3" />
            </tr>
          </thead>
          <tbody>
            {portals.map((p) => (
              <tr key={p.id} className="border-b border-border/60 last:border-0 align-top">
                <td className="p-3 font-semibold">{p.name}</td>
                <td className="p-3 capitalize">{p.type.replace('_', ' ')}</td>
                <td className="p-3 font-mono text-muted">
                  {p.type === 'super_admin' ? `/r/${slug}` : `/r/${slug}/portal/${p.route_key}`}
                </td>
                <td className="p-3">
                  <span className={p.status === 'active' ? 'text-ok' : 'text-danger'}>
                    {p.status}
                  </span>
                </td>
                <td className="p-3 text-muted">
                  {p.last_login_at ? formatDateTime(p.last_login_at) : '—'}
                </td>
                <td className="p-3 text-right whitespace-nowrap">
                  {p.type === 'super_admin' ? (
                    <span className="text-muted">—</span>
                  ) : (
                    <>
                      <Button
                        variant="ghost"
                        disabled={busy}
                        onClick={() =>
                          patch(p.id, { status: p.status === 'active' ? 'disabled' : 'active' })
                        }
                      >
                        {p.status === 'active' ? 'Disable' : 'Enable'}
                      </Button>
                      <Button
                        variant="ghost"
                        className="ml-1.5"
                        disabled={busy}
                        onClick={() => resetPassword(p.id, p.name)}
                      >
                        Reset password
                      </Button>
                      <Button
                        variant="danger"
                        className="ml-1.5"
                        disabled={busy}
                        onClick={() => remove(p.id)}
                      >
                        Delete
                      </Button>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}
