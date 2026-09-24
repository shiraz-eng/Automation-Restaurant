'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { usePortalSupabase } from '@/components/PortalProvider';
import { Button, Card, Field, Input } from '@/components/ui';
import { formatDateTime } from '@/lib/format';
import { PortalPreview } from './PortalPreview';
import { Plus, Search, Users, X } from 'lucide-react';

const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

export type Portal = {
  id: string;
  name: string;
  type: string;
  route_key: string;
  status: 'active' | 'disabled';
  permissions: string[];
  email: string | null;
  last_login_at: string | null;
  last_logout_at: string | null;
  created_at: string;
};
export type PermRow = { key: string; grp: string; label: string };
export type StaffMember = { id: string; email: string; full_name: string | null; role: string; status: string };
export type PortalStaffLink = { portal_id: string; membership_id: string };

// Every portal is built from scratch — a name plus whichever permissions
// are picked in the grid below, nothing preset. `type` is no longer
// user-chosen; new portals are always 'custom', and an existing portal
// created under an older preset type (checkout/kitchen/attendance/
// manager) keeps whatever type it already has so its "Edit access" flow
// (which resubmits `type` unchanged) keeps working exactly as before.

export function PortalsManager({
  slug,
  restaurantName,
  logoUrl,
  portals,
  perms,
  staff,
  links,
}: {
  slug: string;
  restaurantName: string;
  logoUrl: string | null;
  portals: Portal[];
  perms: PermRow[];
  staff: StaffMember[];
  links: PortalStaffLink[];
}) {
  const router = useRouter();
  const supabase = usePortalSupabase();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const [formOpen, setFormOpen] = useState(false);
  const [name, setName] = useState('');
  const [type, setType] = useState('custom');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [editId, setEditId] = useState<string | null>(null);
  const [loginEmail, setLoginEmail] = useState('');
  const [loginPassword, setLoginPassword] = useState('');
  const [permSearch, setPermSearch] = useState('');

  const [staffEditId, setStaffEditId] = useState<string | null>(null);
  const [staffDraft, setStaffDraft] = useState<Set<string>>(new Set());

  const groups = useMemo(() => {
    const m = new Map<string, PermRow[]>();
    for (const p of perms) m.set(p.grp, [...(m.get(p.grp) ?? []), p]);
    return [...m.entries()];
  }, [perms]);

  const filteredGroups = useMemo(() => {
    const q = permSearch.trim().toLowerCase();
    if (!q) return groups;
    return groups
      .map(([grp, rows]) => [grp, rows.filter((r) => r.label.toLowerCase().includes(q) || r.key.toLowerCase().includes(q))] as [string, PermRow[]])
      .filter(([, rows]) => rows.length > 0);
  }, [groups, permSearch]);

  const staffByPortal = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const l of links) m.set(l.portal_id, [...(m.get(l.portal_id) ?? []), l.membership_id]);
    return m;
  }, [links]);
  const staffById = useMemo(() => new Map(staff.map((s) => [s.id, s])), [staff]);

  async function token() {
    const {
      data: { session },
    } = await supabase.auth.getSession();
    return session?.access_token ?? '';
  }

  function toggle(key: string) {
    setSelected((s) => {
      const n = new Set(s);
      n.has(key) ? n.delete(key) : n.add(key);
      return n;
    });
  }
  function toggleGroup(rows: PermRow[]) {
    const allOn = rows.every((r) => selected.has(r.key));
    setSelected((s) => {
      const n = new Set(s);
      for (const r of rows) (allOn ? n.delete(r.key) : n.add(r.key));
      return n;
    });
  }

  async function createPortal(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setNotice(null);
    if (name.trim().length < 2) return setError('Give the portal a name.');
    if (loginPassword && loginPassword.length < 8) {
      return setError('Password must be at least 8 characters — or leave it blank.');
    }
    setBusy(true);
    try {
      if (editId) {
        // Editing an existing portal's access — the SAME /api/portals/:id
        // PATCH used for status/rename, so it goes through the same
        // anti-escalation check and immediately recomputes every linked
        // staff member's effective permissions and the portal login's own
        // Auth metadata. The generated portal reads portal.permissions
        // fresh from the database on every request, so whatever is saved
        // here takes effect on this portal's very next page load — no
        // separate "rebuild" step.
        const res = await fetch(`${API}/api/portals/${editId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${await token()}` },
          body: JSON.stringify({
            slug,
            name: name.trim(),
            type,
            permissions: [...selected],
            ...(loginEmail.trim() ? { email: loginEmail.trim() } : {}),
          }),
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) {
          setError(body.message ?? body.error ?? 'Could not update the portal.');
          return;
        }
        // A password change is a separate call (POST /:id/password) — the
        // PATCH above only ever touches name/type/permissions/status/email.
        let passwordNotice = '';
        if (loginPassword) {
          const pwRes = await fetch(`${API}/api/portals/${editId}/password`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${await token()}` },
            body: JSON.stringify({ slug, password: loginPassword }),
          });
          if (!pwRes.ok) {
            const pwBody = await pwRes.json().catch(() => ({}));
            setError(pwBody.message ?? pwBody.error ?? 'Access was updated, but the password change failed.');
            return;
          }
          passwordNotice = `\n  Password: ${loginPassword}\n(Shown once — copy it now.)`;
        }
        setNotice(`Portal "${name.trim()}" updated.${passwordNotice}`);
        closeForm();
        router.refresh();
        return;
      }

      const res = await fetch(`${API}/api/portals`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${await token()}` },
        body: JSON.stringify({
          slug,
          name: name.trim(),
          type,
          permissions: [...selected],
          ...(loginEmail.trim() ? { email: loginEmail.trim() } : {}),
          ...(loginPassword ? { password: loginPassword } : {}),
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) return setError(body.message ?? body.error ?? 'Could not create the portal.');
      setNotice(
        `Portal "${body.portal.name}" created.\n  URL:      ${body.url}\n  Email:    ${body.login.email}\n  Password: ${body.login.password}\n(Shown once — copy it now.)`,
      );
      closeForm();
      router.refresh();
    } catch {
      setError('Network error — try again.');
    } finally {
      setBusy(false);
    }
  }

  function openCreate() {
    setError(null);
    setNotice(null);
    setEditId(null);
    setName('');
    setType('custom');
    setSelected(new Set());
    setLoginEmail('');
    setLoginPassword('');
    setPermSearch('');
    setFormOpen(true);
  }
  function startEditAccess(p: Portal) {
    setError(null);
    setNotice(null);
    setEditId(p.id);
    setName(p.name);
    setType(p.type);
    setSelected(new Set(p.permissions));
    setLoginEmail(p.email ?? '');
    setLoginPassword('');
    setPermSearch('');
    setFormOpen(true);
  }
  function closeForm() {
    setFormOpen(false);
    setEditId(null);
    setName('');
    setType('custom');
    setSelected(new Set());
    setLoginEmail('');
    setLoginPassword('');
  }

  async function patch(id: string, changes: Record<string, unknown>) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`${API}/api/portals/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${await token()}` },
        body: JSON.stringify({ slug, ...changes }),
      });
      if (!res.ok) {
        const b = await res.json().catch(() => ({}));
        setError(b.message ?? b.error ?? 'Update failed.');
        return;
      }
      router.refresh();
    } catch {
      setError('Network error — try again.');
    } finally {
      setBusy(false);
    }
  }

  async function resetPassword(id: string, portalName: string) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(`${API}/api/portals/${id}/password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${await token()}` },
        body: JSON.stringify({ slug }),
      });
      const b = await res.json().catch(() => ({}));
      if (!res.ok) return setError(b.message ?? b.error ?? 'Reset failed.');
      setNotice(`New password for "${portalName}": ${b.password}\n(Shown once.)`);
    } catch {
      setError('Network error — try again.');
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`${API}/api/portals/${id}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${await token()}` },
        body: JSON.stringify({ slug }),
      });
      if (!res.ok) {
        const b = await res.json().catch(() => ({}));
        setError(b.message ?? b.error ?? 'Delete failed.');
        return;
      }
      router.refresh();
    } catch {
      setError('Network error — try again.');
    } finally {
      setBusy(false);
    }
  }

  function startStaffEdit(portalId: string) {
    setError(null);
    setStaffEditId(portalId);
    setStaffDraft(new Set(staffByPortal.get(portalId) ?? []));
  }
  function toggleStaff(membershipId: string) {
    setStaffDraft((s) => {
      const n = new Set(s);
      n.has(membershipId) ? n.delete(membershipId) : n.add(membershipId);
      return n;
    });
  }
  async function saveStaff(portalId: string) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`${API}/api/portals/${portalId}/staff`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${await token()}` },
        body: JSON.stringify({ slug, membership_ids: [...staffDraft] }),
      });
      if (!res.ok) {
        const b = await res.json().catch(() => ({}));
        setError(b.message ?? b.error ?? 'Could not update assigned staff.');
        return;
      }
      setStaffEditId(null);
      router.refresh();
    } catch {
      setError('Network error — try again.');
    } finally {
      setBusy(false);
    }
  }

  const customPortals = portals.filter((p) => p.type !== 'super_admin');
  const activeCount = customPortals.filter((p) => p.status === 'active').length;

  return (
    <div className="space-y-5">
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

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-4 text-xs text-muted">
          <span>
            <span className="font-bold text-body text-sm">{customPortals.length}</span> portals
          </span>
          <span>
            <span className="font-bold text-ok text-sm">{activeCount}</span> active
          </span>
        </div>
        <Button onClick={openCreate} className="inline-flex items-center gap-1.5">
          <Plus size={14} /> Create Custom Portal
        </Button>
      </div>

      {formOpen && (
        <Card className="border-primary/30">
          <div className="flex items-start justify-between mb-4">
            <div>
              <h2 className="font-bold text-sm">{editId ? `Edit access — ${name}` : 'Create custom portal'}</h2>
              <p className="text-muted text-[11px] mt-0.5">
                A portal is a name plus the individual permissions you grant it — nothing more.
                There&rsquo;s no predefined &ldquo;Kitchen&rdquo; or &ldquo;Finance&rdquo; portal to pick.
              </p>
            </div>
            <button type="button" onClick={closeForm} className="text-muted hover:text-body shrink-0" aria-label="Close">
              <X size={16} />
            </button>
          </div>

          <form onSubmit={createPortal} className="grid gap-6 lg:grid-cols-[1.3fr_1fr]">
            <div className="space-y-4">
              <Field label="Portal name">
                <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Counter 1" autoFocus />
              </Field>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <Field label="Login email">
                  <Input
                    type="email"
                    value={loginEmail}
                    onChange={(e) => setLoginEmail(e.target.value)}
                    placeholder={editId ? 'Unchanged' : 'Auto-generated if left blank'}
                  />
                </Field>
                <Field label={editId ? 'New password' : 'Password'}>
                  <Input
                    type="text"
                    value={loginPassword}
                    onChange={(e) => setLoginPassword(e.target.value)}
                    placeholder={editId ? 'Leave blank to keep current' : 'Auto-generated if left blank'}
                  />
                </Field>
              </div>

              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <span className="text-muted text-[11px] font-semibold">
                    Permissions <span className="text-body font-bold">({selected.size} selected)</span>
                  </span>
                  <div className="relative">
                    <Search size={12} className="absolute left-2 top-1/2 -translate-y-1/2 text-muted" />
                    <input
                      value={permSearch}
                      onChange={(e) => setPermSearch(e.target.value)}
                      placeholder="Search permissions…"
                      className="rounded border border-border bg-surface pl-6 pr-2 py-1 text-[11px] outline-none focus:border-primary w-40"
                    />
                  </div>
                </div>
                <div className="max-h-80 overflow-y-auto pr-1 grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-3">
                  {filteredGroups.length === 0 ? (
                    <p className="text-muted text-xs col-span-2">No permissions match &ldquo;{permSearch}&rdquo;.</p>
                  ) : (
                    filteredGroups.map(([grp, rows]) => (
                      <div key={grp}>
                        <button
                          type="button"
                          onClick={() => toggleGroup(rows)}
                          className="text-[11px] font-bold text-muted mb-1 hover:text-primary"
                        >
                          {grp}
                        </button>
                        {rows.map((r) => (
                          <label key={r.key} className="flex items-center gap-2 text-xs py-0.5">
                            <input type="checkbox" checked={selected.has(r.key)} onChange={() => toggle(r.key)} />
                            {r.label}
                          </label>
                        ))}
                      </div>
                    ))
                  )}
                </div>
              </div>

              <div className="flex gap-2 pt-1">
                <Button type="submit" disabled={busy}>
                  {editId ? 'Save access' : 'Create portal'}
                </Button>
                <Button type="button" variant="ghost" disabled={busy} onClick={closeForm}>
                  Cancel
                </Button>
              </div>
            </div>

            <div>
              <div className="text-[11px] font-semibold text-muted mb-1.5">Live workspace preview</div>
              <PortalPreview restaurantName={restaurantName} logoUrl={logoUrl} portalName={name} permissions={selected} />
            </div>
          </form>
        </Card>
      )}

      {customPortals.length === 0 ? (
        <Card>
          <p className="text-muted text-xs">
            No custom portals yet. Create one to give a team member exactly the access they need.
          </p>
        </Card>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {customPortals.map((p) => {
              const assigned = staffByPortal.get(p.id) ?? [];
              return (
                <Card key={p.id} className="flex flex-col">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="font-bold text-sm truncate">{p.name}</div>
                      <div className="text-muted text-[11px] capitalize">{p.type.replace('_', ' ')}</div>
                    </div>
                    <span
                      className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold uppercase ${
                        p.status === 'active' ? 'bg-ok/10 text-ok' : 'bg-danger/10 text-danger'
                      }`}
                    >
                      {p.status}
                    </span>
                  </div>

                  <div className="mt-3 flex items-center gap-3 text-[11px] text-muted">
                    <span>
                      <span className="font-bold text-body">{p.permissions.includes('*') ? 'All' : p.permissions.length}</span>{' '}
                      permissions
                    </span>
                    <span className="flex items-center gap-1">
                      <Users size={11} />
                      {assigned.length}
                    </span>
                  </div>
                  <div className="text-[10px] font-mono text-muted mt-1.5 truncate">/r/{slug}/portal/{p.route_key}</div>
                  {p.email && <div className="text-[10px] text-muted truncate">{p.email}</div>}
                  <div className="text-[10px] text-muted mt-1">
                    {p.last_login_at ? `Last sign-in ${formatDateTime(p.last_login_at)}` : 'Never signed in'}
                  </div>
                  {p.last_logout_at && (
                    <div className="text-[10px] text-muted">Last sign-out {formatDateTime(p.last_logout_at)}</div>
                  )}

                  <div className="mt-3 pt-3 border-t border-border flex flex-wrap gap-1.5">
                    <Button variant="ghost" disabled={busy} onClick={() => startEditAccess(p)}>
                      Edit access
                    </Button>
                    <Button
                      variant="ghost"
                      disabled={busy}
                      onClick={() => (staffEditId === p.id ? setStaffEditId(null) : startStaffEdit(p.id))}
                    >
                      {staffEditId === p.id ? 'Cancel' : 'Assign staff'}
                    </Button>
                    <Button variant="ghost" disabled={busy} onClick={() => patch(p.id, { status: p.status === 'active' ? 'disabled' : 'active' })}>
                      {p.status === 'active' ? 'Disable' : 'Enable'}
                    </Button>
                    <Button variant="ghost" disabled={busy} onClick={() => resetPassword(p.id, p.name)}>
                      Reset password
                    </Button>
                    <Button variant="danger" disabled={busy} onClick={() => remove(p.id)}>
                      Delete
                    </Button>
                  </div>

                  {staffEditId === p.id && (
                    <div className="mt-3 pt-3 border-t border-border">
                      <div className="text-[11px] font-semibold text-muted mb-1.5">
                        Staff assigned this portal gain its permissions in addition to their own role.
                      </div>
                      {staff.length === 0 ? (
                        <p className="text-muted text-xs">No staff accounts yet — add one on the Staff page.</p>
                      ) : (
                        <div className="grid grid-cols-1 gap-1.5 max-h-40 overflow-y-auto">
                          {staff.map((m) => (
                            <label key={m.id} className="flex items-center gap-2 text-xs">
                              <input type="checkbox" checked={staffDraft.has(m.id)} onChange={() => toggleStaff(m.id)} />
                              <span className="truncate">{m.full_name || m.email}</span>
                              <span className="text-muted text-[10px] shrink-0">({m.role})</span>
                            </label>
                          ))}
                        </div>
                      )}
                      <div className="flex gap-2 mt-2.5">
                        <Button disabled={busy} onClick={() => saveStaff(p.id)}>
                          {busy ? 'Saving…' : 'Save'}
                        </Button>
                        <Button variant="ghost" disabled={busy} onClick={() => setStaffEditId(null)}>
                          Cancel
                        </Button>
                      </div>
                    </div>
                  )}
                </Card>
              );
            })}
        </div>
      )}

      {(() => {
        const admin = portals.find((p) => p.type === 'super_admin');
        return admin ? (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded border border-border p-3">
            <p className="text-muted text-[11px]">
              <span className="font-semibold text-body">{admin.name}</span> (Super Admin) has full
              control of this restaurant and can&rsquo;t be edited or removed here — only its
              password can be changed.
            </p>
            <Button variant="ghost" disabled={busy} onClick={() => resetPassword(admin.id, admin.name)}>
              Change password
            </Button>
          </div>
        ) : null;
      })()}
    </div>
  );
}
