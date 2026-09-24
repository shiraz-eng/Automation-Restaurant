'use client';

import { useMemo, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { usePortalSupabase } from '@/components/PortalProvider';
import { Button, Card, Field, Input } from '@/components/ui';
import { formatDateTime } from '@/lib/format';
import { PortalPreview } from './PortalPreview';
import { ChevronDown, ChevronRight, Plus, Search, X } from 'lucide-react';

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
export type PermType = 'read' | 'write' | 'approval' | 'export';
/** type/risk_level come from permission_catalog (tenant-migration 0057);
 *  null on a tenant that hasn't received that migration yet. */
export type PermRow = { key: string; grp: string; label: string; type: PermType | null; risk_level: 'normal' | 'high' | null };

const TYPE_LABEL: Record<PermType, string> = { read: 'Read', write: 'Write', approval: 'Approval', export: 'Export' };
const TYPE_STYLE: Record<PermType, string> = {
  read: 'bg-primary/10 text-primary',
  write: 'bg-warn/10 text-warn',
  approval: 'bg-danger/10 text-danger',
  export: 'bg-ok/10 text-ok',
};
type PermFilter = 'all' | 'selected' | 'unselected' | PermType | 'high';

function PermBadges({ p }: { p: PermRow }) {
  return (
    <span className="flex items-center gap-1 shrink-0">
      {p.type && (
        <span className={`rounded px-1.5 py-0.5 text-[9px] font-bold uppercase ${TYPE_STYLE[p.type]}`}>{TYPE_LABEL[p.type]}</span>
      )}
      {p.risk_level === 'high' && (
        <span className="rounded border border-danger/50 px-1.5 py-0.5 text-[9px] font-bold uppercase text-danger">High risk</span>
      )}
    </span>
  );
}

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
  caps = { create: true, update: true, disable: true, credentials: true },
  callerPermissions = ['*'],
  selfPortalId = null,
  roles = [],
}: {
  slug: string;
  restaurantName: string;
  logoUrl: string | null;
  portals: Portal[];
  perms: PermRow[];
  /** portals.create / portals.update / portals.disable / portals.credentials. */
  caps?: { create: boolean; update: boolean; disable: boolean; credentials: boolean };
  /** The caller's own keys: only these can be granted, and only portals
   *  holding a subset of them can be managed (the API enforces both). */
  callerPermissions?: string[];
  /** A portal viewing Portal Management never sees controls for itself. */
  selfPortalId?: string | null;
  /** Role presets offered as a starting point when creating a portal. */
  roles?: { key: string; name: string; permissions: string[] }[];
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
  const [permFilter, setPermFilter] = useState<PermFilter>('all');
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());


  const callerAll = callerPermissions.includes('*');
  const grantable = useCallback((k: string) => callerAll || callerPermissions.includes(k), [callerAll, callerPermissions]);
  const manageable = (p: Portal) => p.id !== selfPortalId && (callerAll || (!p.permissions.includes('*') && p.permissions.every(grantable)));
  const permByKey = useMemo(() => new Map(perms.map((p) => [p.key, p])), [perms]);
  const hasMeta = useMemo(() => perms.some((p) => p.type !== null), [perms]);

  const groups = useMemo(() => {
    const m = new Map<string, PermRow[]>();
    for (const p of perms) m.set(p.grp, [...(m.get(p.grp) ?? []), p]);
    return [...m.entries()];
  }, [perms]);

  const filteredGroups = useMemo(() => {
    const q = permSearch.trim().toLowerCase();
    const matchesFilter = (r: PermRow) => {
      switch (permFilter) {
        case 'all':
          return true;
        case 'selected':
          return selected.has(r.key);
        case 'unselected':
          return !selected.has(r.key);
        case 'high':
          return r.risk_level === 'high';
        default:
          return r.type === permFilter;
      }
    };
    return groups
      .map(
        ([grp, rows]) =>
          [grp, rows.filter((r) => (!q || r.label.toLowerCase().includes(q) || r.key.toLowerCase().includes(q)) && matchesFilter(r))] as [
            string,
            PermRow[],
          ],
      )
      .filter(([, rows]) => rows.length > 0);
  }, [groups, permSearch, permFilter, selected]);

  // Pill counts are over the whole catalog, not the current search — the
  // same "All N / Selected N / ..." totals regardless of what's typed.
  const filterCounts = useMemo(() => {
    const c: Record<PermFilter, number> = { all: perms.length, selected: 0, unselected: 0, read: 0, write: 0, approval: 0, export: 0, high: 0 };
    for (const p of perms) {
      if (selected.has(p.key)) c.selected++;
      else c.unselected++;
      if (p.type) c[p.type]++;
      if (p.risk_level === 'high') c.high++;
    }
    return c;
  }, [perms, selected]);

  // Selected-access column: grouped by catalog group, plus any stored key
  // that isn't in the catalog at all (legacy grants) so nothing on an
  // existing portal is silently hidden from its own editor.
  const selectedGroups = useMemo(() => {
    const m = new Map<string, PermRow[]>();
    for (const key of selected) {
      const p = permByKey.get(key) ?? { key, grp: 'Other', label: key, type: null, risk_level: null };
      m.set(p.grp, [...(m.get(p.grp) ?? []), p]);
    }
    return [...m.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [selected, permByKey]);

  const selectedSummary = useMemo(() => {
    const c = { read: 0, write: 0, approval: 0, export: 0, high: 0 };
    for (const key of selected) {
      const p = permByKey.get(key);
      if (p?.type) c[p.type]++;
      if (p?.risk_level === 'high') c.high++;
    }
    return c;
  }, [selected, permByKey]);

  const searchOrFilterActive = permSearch.trim() !== '' || permFilter !== 'all';

  function toggleCollapsed(grp: string) {
    setCollapsed((c) => {
      const n = new Set(c);
      n.has(grp) ? n.delete(grp) : n.add(grp);
      return n;
    });
  }
  function setVisible(on: boolean) {
    const visible = filteredGroups.flatMap(([, rows]) => rows.map((r) => r.key)).filter(grantable);
    setSelected((s) => {
      const n = new Set(s);
      for (const k of visible) (on ? n.add(k) : n.delete(k));
      return n;
    });
  }


  async function token() {
    const {
      data: { session },
    } = await supabase.auth.getSession();
    return session?.access_token ?? '';
  }

  function toggle(key: string) {
    if (!grantable(key) && !selected.has(key)) return;
    setSelected((s) => {
      const n = new Set(s);
      n.has(key) ? n.delete(key) : n.add(key);
      return n;
    });
  }
  function toggleGroup(rows: PermRow[]) {
    const own = rows.filter((r) => grantable(r.key));
    const allOn = own.every((r) => selected.has(r.key));
    setSelected((s) => {
      const n = new Set(s);
      for (const r of own) (allOn ? n.delete(r.key) : n.add(r.key));
      return n;
    });
  }
  function startFromRole(key: string) {
    const r = roles.find((x) => x.key === key);
    if (!r) return;
    setSelected(new Set(r.permissions.filter((k) => k !== '*' && grantable(k))));
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
        if (loginPassword && caps.credentials) {
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
    setPermFilter('all');
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
    setPermFilter('all');
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
        {caps.create && (
          <Button onClick={openCreate} className="inline-flex items-center gap-1.5">
            <Plus size={14} /> Create Custom Portal
          </Button>
        )}
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

          <form onSubmit={createPortal} className="space-y-5">
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <Field label="Portal name">
                <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Counter 1" autoFocus />
              </Field>
              <Field label="Login email">
                <Input
                  type="email"
                  value={loginEmail}
                  onChange={(e) => setLoginEmail(e.target.value)}
                  placeholder={editId ? 'Unchanged' : 'Auto-generated if left blank'}
                />
              </Field>
              {(!editId || caps.credentials) && (
              <Field label={editId ? 'New password' : 'Password'}>
                <Input
                  type="text"
                  value={loginPassword}
                  onChange={(e) => setLoginPassword(e.target.value)}
                  placeholder={editId ? 'Leave blank to keep current' : 'Auto-generated if left blank'}
                />
              </Field>
              )}
            </div>

            <div className="grid gap-5 lg:grid-cols-2 xl:grid-cols-[1.4fr_1fr_1fr] items-start">
              {/* ── 1. Permissions ── */}
              <div className="min-w-0">
                <div className="flex items-center justify-between gap-2 mb-2">
                  <span className="text-xs font-bold">Permissions</span>
                  <div className="relative">
                    <Search size={12} className="absolute left-2 top-1/2 -translate-y-1/2 text-muted" />
                    <input
                      value={permSearch}
                      onChange={(e) => setPermSearch(e.target.value)}
                      placeholder="Search permissions…"
                      className="rounded border border-border bg-surface pl-6 pr-2 py-1 text-[11px] outline-none focus:border-primary w-44"
                    />
                  </div>
                </div>
                <div className="flex flex-wrap gap-1 mb-2">
                  {(
                    [
                      ['all', 'All'],
                      ['selected', 'Selected'],
                      ['unselected', 'Unselected'],
                      ...(hasMeta
                        ? ([
                            ['read', 'Read'],
                            ['write', 'Write'],
                            ['approval', 'Approval'],
                            ['export', 'Export'],
                            ['high', 'High risk'],
                          ] as [PermFilter, string][])
                        : []),
                    ] as [PermFilter, string][]
                  ).map(([f, lbl]) => (
                    <button
                      key={f}
                      type="button"
                      onClick={() => setPermFilter(f)}
                      className={`rounded-full px-2 py-0.5 text-[10px] font-semibold border ${
                        permFilter === f ? 'bg-primary text-primary-fg border-primary' : 'border-border text-muted hover:text-body'
                      }`}
                    >
                      {lbl} {filterCounts[f]}
                    </button>
                  ))}
                </div>
                {!editId && roles.length > 0 && (
                  <div className="mb-2">
                    <select
                      defaultValue=""
                      onChange={(e) => {
                        startFromRole(e.target.value);
                        e.target.value = '';
                      }}
                      className="rounded border border-border bg-surface px-2 py-1 text-[11px] outline-none focus:border-primary"
                    >
                      <option value="">Start from a role…</option>
                      {roles
                        .filter((r) => r.key !== 'owner')
                        .map((r) => (
                          <option key={r.key} value={r.key}>
                            {r.name}
                          </option>
                        ))}
                    </select>
                  </div>
                )}
                <div className="flex gap-3 mb-2 text-[10px]">
                  <button type="button" onClick={() => setVisible(true)} className="font-semibold text-primary hover:underline">
                    Select visible
                  </button>
                  <button type="button" onClick={() => setVisible(false)} className="font-semibold text-muted hover:text-body hover:underline">
                    Clear visible
                  </button>
                </div>
                <div className="max-h-[30rem] overflow-y-auto pr-1 space-y-1.5 rounded border border-border p-2">
                  {filteredGroups.length === 0 ? (
                    <p className="text-muted text-xs p-2">No permissions match this search/filter.</p>
                  ) : (
                    filteredGroups.map(([grp, rows]) => {
                      const open = searchOrFilterActive || !collapsed.has(grp);
                      const onCount = rows.filter((r) => selected.has(r.key)).length;
                      return (
                        <div key={grp} className="rounded bg-main/40">
                          <div className="flex items-center justify-between gap-2 px-2 py-1.5">
                            <button
                              type="button"
                              onClick={() => toggleCollapsed(grp)}
                              className="flex items-center gap-1 text-[11px] font-bold text-body min-w-0"
                            >
                              {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                              <span className="truncate">{grp}</span>
                              <span className="text-muted font-normal">
                                ({onCount}/{rows.length})
                              </span>
                            </button>
                            <button
                              type="button"
                              onClick={() => toggleGroup(rows)}
                              className="text-[10px] font-semibold text-muted hover:text-primary shrink-0"
                            >
                              {rows.every((r) => selected.has(r.key)) ? 'Clear' : 'Select all'}
                            </button>
                          </div>
                          {open && (
                            <div className="px-2 pb-1.5 space-y-0.5">
                              {rows.map((r) => (
                                <label
                                  key={r.key}
                                  title={grantable(r.key) ? undefined : "You don't hold this permission, so you can't grant it."}
                                  className={`flex items-center justify-between gap-2 text-xs py-0.5 ${grantable(r.key) ? 'cursor-pointer' : 'opacity-40'}`}
                                >
                                  <span className="flex items-center gap-2 min-w-0">
                                    <input
                                      type="checkbox"
                                      disabled={!grantable(r.key) && !selected.has(r.key)}
                                      checked={selected.has(r.key)}
                                      onChange={() => toggle(r.key)}
                                    />
                                    <span className="truncate">{r.label}</span>
                                  </span>
                                  <PermBadges p={r} />
                                </label>
                              ))}
                            </div>
                          )}
                        </div>
                      );
                    })
                  )}
                </div>
              </div>

              {/* ── 2. Selected access ── */}
              <div className="min-w-0">
                <div className="flex items-center justify-between gap-2 mb-2">
                  <span className="text-xs font-bold">
                    Selected access <span className="text-muted font-normal">({selected.size})</span>
                  </span>
                  {selected.size > 0 && (
                    <button type="button" onClick={() => setSelected(new Set())} className="text-[10px] font-semibold text-muted hover:text-danger">
                      Clear all
                    </button>
                  )}
                </div>
                {hasMeta && (
                  <div className="flex flex-wrap gap-x-3 gap-y-1 mb-2 text-[10px] text-muted">
                    <span>
                      Read <b className="text-body">{selectedSummary.read}</b>
                    </span>
                    <span>
                      Write <b className="text-body">{selectedSummary.write}</b>
                    </span>
                    <span>
                      Approval <b className="text-body">{selectedSummary.approval}</b>
                    </span>
                    <span>
                      Export <b className="text-body">{selectedSummary.export}</b>
                    </span>
                    <span className={selectedSummary.high > 0 ? 'text-danger font-semibold' : ''}>
                      High risk <b>{selectedSummary.high}</b>
                    </span>
                  </div>
                )}
                <div className="max-h-[30rem] overflow-y-auto pr-1 rounded border border-border p-2">
                  {selectedGroups.length === 0 ? (
                    <p className="text-muted text-xs p-2">Nothing selected yet — tick permissions on the left.</p>
                  ) : (
                    <div className="space-y-2">
                      {selectedGroups.map(([grp, rows]) => (
                        <div key={grp}>
                          <div className="text-[10px] font-bold uppercase tracking-wide text-muted mb-0.5">
                            {grp} ({rows.length})
                          </div>
                          <ul className="space-y-0.5">
                            {rows.map((r) => (
                              <li key={r.key} className="flex items-center justify-between gap-2 text-xs">
                                <span className="truncate">{r.label}</span>
                                <span className="flex items-center gap-1 shrink-0">
                                  <PermBadges p={r} />
                                  <button
                                    type="button"
                                    onClick={() => toggle(r.key)}
                                    className="text-muted hover:text-danger"
                                    aria-label={`Remove ${r.label}`}
                                  >
                                    <X size={12} />
                                  </button>
                                </span>
                              </li>
                            ))}
                          </ul>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>

              {/* ── 3. Live preview ── */}
              <div className="min-w-0 lg:col-span-2 xl:col-span-1">
                <div className="text-xs font-bold mb-2">Live portal preview</div>
                <PortalPreview restaurantName={restaurantName} logoUrl={logoUrl} portalName={name} permissions={selected} catalog={perms} />
              </div>
            </div>

            <div className="flex gap-2 pt-1 border-t border-border">
              <Button type="submit" disabled={busy} className="mt-3">
                {editId ? 'Save access' : 'Create portal'}
              </Button>
              <Button type="button" variant="ghost" disabled={busy} onClick={closeForm} className="mt-3">
                Cancel
              </Button>
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
                  </div>
                  <div className="text-[10px] font-mono text-muted mt-1.5 truncate">/r/{slug}/portal/{p.route_key}</div>
                  {p.email && <div className="text-[10px] text-muted truncate">{p.email}</div>}
                  <div className="text-[10px] text-muted mt-1">
                    {p.last_login_at ? `Last sign-in ${formatDateTime(p.last_login_at)}` : 'Never signed in'}
                  </div>
                  {p.last_logout_at && (
                    <div className="text-[10px] text-muted">Last sign-out {formatDateTime(p.last_logout_at)}</div>
                  )}

                  {manageable(p) ? (
                  <div className="mt-3 pt-3 border-t border-border flex flex-wrap gap-1.5">
                    {caps.update && (
                      <Button variant="ghost" disabled={busy} onClick={() => startEditAccess(p)}>
                        Edit access
                      </Button>
                    )}
                    {(caps.disable || caps.update) && (
                      <Button variant="ghost" disabled={busy} onClick={() => patch(p.id, { status: p.status === 'active' ? 'disabled' : 'active' })}>
                        {p.status === 'active' ? 'Disable' : 'Enable'}
                      </Button>
                    )}
                    {caps.credentials && (
                      <Button variant="ghost" disabled={busy} onClick={() => resetPassword(p.id, p.name)}>
                        Reset password
                      </Button>
                    )}
                    {caps.update && (
                      <Button variant="danger" disabled={busy} onClick={() => remove(p.id)}>
                        Delete
                      </Button>
                    )}
                  </div>
                  ) : (
                    <p className="mt-3 pt-3 border-t border-border text-[10px] text-muted">
                      {p.id === selfPortalId ? 'This is your portal.' : 'Has access you don’t hold — view only.'}
                    </p>
                  )}

                </Card>
              );
            })}
        </div>
      )}

      {(() => {
        const admin = portals.find((p) => p.type === 'super_admin');
        return admin ? (
          <p className="text-muted text-[11px]">
            <span className="font-semibold text-body">{admin.name}</span> (Super Admin) has full
            control of this restaurant and can&rsquo;t be edited or removed here. It&rsquo;s not a
            separate login — the Owner signs in as themselves; change your own password from the
            account menu in the sidebar.
          </p>
        ) : null;
      })()}
    </div>
  );
}
