'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { usePortalSupabase } from '@/components/PortalProvider';
import { Button, Card, Field, Input } from '@/components/ui';

type Role = { id: string; key: string; name: string; permissions: string[]; is_system: boolean };
type CatalogRow = { key: string; grp: string; label: string };
type Member = {
  membership_id: string;
  email: string;
  full_name: string | null;
  role: string;
  status: string;
  extra_permissions: string[];
  effective_permissions: string[];
};

function slugKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
}

/**
 * Role presets (public.roles). roles.view lists them, roles.create adds a
 * custom preset, roles.update edits a preset's permissions (a system
 * role's change applies to every member holding it), roles.delete removes
 * a custom one. The database refuses any role granting a permission the
 * caller doesn't hold (guard_role_write, 0058) and never allows '*' outside
 * the owner row.
 */
export function RolesManager({
  canCreate,
  canUpdate,
  canDelete,
  callerPermissions,
}: {
  canCreate: boolean;
  canUpdate: boolean;
  canDelete: boolean;
  /** The caller's own keys — only these are offered when editing ('*' = all). */
  callerPermissions: string[];
}) {
  const supabase = usePortalSupabase();
  const [roles, setRoles] = useState<Role[]>([]);
  const [catalog, setCatalog] = useState<CatalogRow[]>([]);
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [draft, setDraft] = useState<Set<string>>(new Set());
  const [newName, setNewName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [r, c] = await Promise.all([
      supabase.from('roles').select('id, key, name, permissions, is_system').order('is_system', { ascending: false }).order('name'),
      supabase.from('permission_catalog').select('key, grp, label').order('grp'),
    ]);
    if (r.error) setError(r.error.message);
    setRoles((r.data ?? []) as Role[]);
    setCatalog((c.data ?? []) as CatalogRow[]);
  }, [supabase]);

  useEffect(() => {
    void load();
  }, [load]);

  const all = callerPermissions.includes('*');
  const grantable = (k: string) => all || callerPermissions.includes(k);
  const labelOf = useMemo(() => new Map(catalog.map((c) => [c.key, c.label])), [catalog]);
  const groups = useMemo(() => {
    const m = new Map<string, CatalogRow[]>();
    for (const c of catalog) {
      const arr = m.get(c.grp) ?? [];
      arr.push(c);
      m.set(c.grp, arr);
    }
    return [...m.entries()];
  }, [catalog]);

  function open(r: Role) {
    setOpenKey(r.key);
    setDraft(new Set(r.permissions));
    setNote(null);
    setError(null);
  }

  async function run(fn: () => PromiseLike<{ error: { message: string } | null }>, ok: string) {
    setBusy(true);
    setError(null);
    setNote(null);
    const { error: e } = await fn();
    setBusy(false);
    if (e) {
      setError(e.message);
      return false;
    }
    setNote(ok);
    await load();
    return true;
  }

  async function create(e: React.FormEvent) {
    e.preventDefault();
    const key = slugKey(newName);
    if (!newName.trim() || !key) {
      setError('Give the role a name.');
      return;
    }
    if (roles.some((r) => r.key === key)) {
      setError('A role with that name already exists.');
      return;
    }
    const ok = await run(
      () => supabase.from('roles').insert({ key, name: newName.trim(), permissions: [], is_system: false }),
      'Role created — tick its permissions below.',
    );
    if (ok) {
      setNewName('');
      setOpenKey(key);
      setDraft(new Set());
    }
  }

  async function save(r: Role) {
    await run(
      () => supabase.from('roles').update({ permissions: [...draft].sort() }).eq('id', r.id),
      `${r.name} saved.`,
    );
  }

  async function remove(r: Role) {
    if (!window.confirm(`Delete the ${r.name} role?`)) return;
    const ok = await run(() => supabase.from('roles').delete().eq('id', r.id), `${r.name} deleted.`);
    if (ok) setOpenKey(null);
  }

  return (
    <div className="space-y-3">
      {canCreate && (
        <Card>
          <form onSubmit={create} className="flex flex-wrap items-end gap-3">
            <Field label="New role name">
              <Input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="Shift lead" className="w-56" />
            </Field>
            <Button type="submit" disabled={busy}>
              Create role
            </Button>
          </form>
          <p className="text-muted text-[11px] mt-2">
            Custom roles are permission presets — use one as the starting point when you create a portal.
          </p>
        </Card>
      )}
      {error && <div className="rounded border border-danger/40 bg-danger/10 text-danger p-3 text-xs">{error}</div>}
      {note && <div className="rounded border border-ok/40 bg-ok/10 text-ok p-3 text-xs">{note}</div>}

      {roles.map((r) => {
        const isOpen = openKey === r.key;
        const isOwner = r.key === 'owner';
        const editable = canUpdate && !isOwner;
        return (
          <Card key={r.id} className="p-0 overflow-hidden">
            <button
              type="button"
              onClick={() => (isOpen ? setOpenKey(null) : open(r))}
              className="w-full flex items-center justify-between gap-2 p-3 text-left"
            >
              <span>
                <span className="font-bold text-sm">{r.name}</span>
                <span className="ml-2 text-[10px] uppercase font-bold text-muted">{r.is_system ? 'built-in' : 'custom'}</span>
              </span>
              <span className="text-[11px] text-muted">
                {isOwner ? 'full access' : `${r.permissions.length} permission${r.permissions.length === 1 ? '' : 's'}`}
              </span>
            </button>
            {isOpen && !isOwner && (
              <div className="border-t border-border p-3 space-y-3">
                {editable ? (
                  <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                    {groups.map(([grp, keys]) => (
                      <div key={grp}>
                        <div className="text-[10px] uppercase tracking-wide font-bold text-muted mb-1">{grp}</div>
                        {keys.map((c) => {
                          const can = grantable(c.key);
                          return (
                            <label key={c.key} className={`flex items-center gap-1.5 text-[11px] ${can ? '' : 'opacity-40'}`}>
                              <input
                                type="checkbox"
                                disabled={!can}
                                checked={draft.has(c.key)}
                                onChange={(e) =>
                                  setDraft((d) => {
                                    const n = new Set(d);
                                    if (e.target.checked) n.add(c.key);
                                    else n.delete(c.key);
                                    return n;
                                  })
                                }
                              />
                              {c.label}
                            </label>
                          );
                        })}
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="flex flex-wrap gap-1">
                    {r.permissions.map((k) => (
                      <span key={k} className="rounded bg-main px-1.5 py-0.5 text-[10px]">
                        {labelOf.get(k) ?? k}
                      </span>
                    ))}
                  </div>
                )}
                <div className="flex gap-2">
                  {editable && (
                    <Button disabled={busy} onClick={() => save(r)}>
                      Save permissions
                    </Button>
                  )}
                  {canDelete && !r.is_system && (
                    <Button variant="danger" disabled={busy} onClick={() => remove(r)}>
                      Delete role
                    </Button>
                  )}
                </div>
                {editable && r.is_system && (
                  <p className="text-[11px] text-warn">
                    Changing a built-in role changes access for every staff member who has it.
                  </p>
                )}
              </div>
            )}
          </Card>
        );
      })}
    </div>
  );
}

/** permissions.view — who holds what, including access inherited from portals. */
export function AccessList() {
  const supabase = usePortalSupabase();
  const [rows, setRows] = useState<Member[]>([]);
  const [catalog, setCatalog] = useState<Map<string, string>>(new Map());
  const [openId, setOpenId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void Promise.all([
      supabase.rpc('member_access_list'),
      supabase.from('permission_catalog').select('key, label'),
    ]).then(([m, c]) => {
      if (m.error) setError(m.error.message);
      setRows((m.data ?? []) as Member[]);
      setCatalog(new Map(((c.data ?? []) as { key: string; label: string }[]).map((r) => [r.key, r.label])));
    });
  }, [supabase]);

  return (
    <Card className="p-0 overflow-hidden">
      <div className="p-3 border-b border-border">
        <h3 className="font-bold text-sm">Who has access</h3>
        <p className="text-muted text-[11px]">Each person&rsquo;s role, extra grants, and everything they can do in total.</p>
      </div>
      {error && <div className="bg-danger/10 text-danger text-xs p-3">{error}</div>}
      <table className="w-full text-left text-xs">
        <tbody>
          {rows.map((m) => {
            const all = m.effective_permissions.includes('*');
            return (
              <tr key={m.membership_id} className="border-b border-border/60 last:border-0 align-top">
                <td className="p-2.5">
                  <div className="font-semibold">{m.full_name || m.email}</div>
                  <div className="text-muted">{m.email}</div>
                </td>
                <td className="p-2.5 capitalize">
                  {m.role}
                  {m.status !== 'active' && <span className="text-muted"> · {m.status}</span>}
                </td>
                <td className="p-2.5">
                  {all ? (
                    <span className="font-bold">Full access</span>
                  ) : (
                    <button
                      type="button"
                      className="text-primary underline"
                      onClick={() => setOpenId(openId === m.membership_id ? null : m.membership_id)}
                    >
                      {m.effective_permissions.length} permissions
                      {m.extra_permissions.length ? ` (${m.extra_permissions.length} extra)` : ''}
                    </button>
                  )}
                  {openId === m.membership_id && (
                    <div className="mt-2 flex flex-wrap gap-1">
                      {m.effective_permissions.map((k) => (
                        <span
                          key={k}
                          className={`rounded px-1.5 py-0.5 text-[10px] ${
                            m.extra_permissions.includes(k) ? 'bg-primary/10 text-primary' : 'bg-main'
                          }`}
                        >
                          {catalog.get(k) ?? k}
                        </span>
                      ))}
                    </div>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </Card>
  );
}
