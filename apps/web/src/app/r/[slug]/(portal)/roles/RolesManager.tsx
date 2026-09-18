'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { usePortalSupabase } from '@/components/PortalProvider';
import { Button, Card, Input } from '@/components/ui';
import { PORTAL_BUNDLES } from '@/lib/portalBundles';

export type Role = {
  id: string;
  key: string;
  name: string;
  permissions: string[];
  is_system: boolean;
};
export type PermRow = { key: string; grp: string; label: string };

function slugKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
}

export function RolesManager({
  roles,
  catalog,
  canEdit,
}: {
  roles: Role[];
  catalog: PermRow[];
  canEdit: boolean;
}) {
  const router = useRouter();
  const supabase = usePortalSupabase();

  const groups = useMemo(() => {
    const m = new Map<string, PermRow[]>();
    for (const p of catalog) {
      const list = m.get(p.grp) ?? [];
      list.push(p);
      m.set(p.grp, list);
    }
    return [...m.entries()];
  }, [catalog]);

  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState<Set<string>>(new Set());
  const [draftName, setDraftName] = useState('');
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function startEdit(r: Role) {
    setCreating(false);
    setEditing(r.id);
    setDraftName(r.name);
    setDraft(new Set(r.permissions));
    setError(null);
  }
  function startCreate() {
    setEditing(null);
    setCreating(true);
    setDraftName('');
    setDraft(new Set());
    setError(null);
  }
  function toggle(key: string) {
    setDraft((s) => {
      const next = new Set(s);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }
  function togglePortal(keys: string[], nowOn: boolean) {
    setDraft((s) => {
      const next = new Set(s);
      for (const k of keys) {
        if (nowOn) next.add(k);
        else next.delete(k);
      }
      return next;
    });
  }

  async function saveEdit(r: Role) {
    setBusy(true);
    setError(null);
    const { error: e } = await supabase
      .from('roles')
      .update({ name: draftName.trim() || r.name, permissions: [...draft] })
      .eq('id', r.id);
    setBusy(false);
    if (e) return setError(e.message);
    setEditing(null);
    router.refresh();
  }

  async function saveCreate() {
    const name = draftName.trim();
    if (name.length < 2) return setError('Give the role a name.');
    setBusy(true);
    setError(null);
    const { error: e } = await supabase
      .from('roles')
      .insert({ key: slugKey(name) || `role_${Date.now()}`, name, permissions: [...draft], is_system: false });
    setBusy(false);
    if (e) return setError(e.message);
    setCreating(false);
    router.refresh();
  }

  async function remove(r: Role) {
    if (!confirm(`Delete the "${r.name}" role?`)) return;
    setBusy(true);
    const { error: e } = await supabase.from('roles').delete().eq('id', r.id);
    setBusy(false);
    if (e) return setError(e.message);
    router.refresh();
  }

  const picker = (
    <div className="mt-3 space-y-4">
      <Input
        placeholder="Role name"
        value={draftName}
        onChange={(e) => setDraftName(e.target.value)}
        className="max-w-xs"
      />

      <div>
        <div className="text-[10px] uppercase tracking-wide text-muted font-bold mb-1.5">Portals</div>
        <div className="grid sm:grid-cols-2 gap-x-6 gap-y-1">
          {PORTAL_BUNDLES.map(({ portal, keys }) => {
            const allOn = keys.every((k) => draft.has(k));
            const someOn = !allOn && keys.some((k) => draft.has(k));
            return (
              <label key={portal} className="flex items-center gap-2 text-xs py-0.5">
                <input
                  type="checkbox"
                  checked={allOn}
                  ref={(el) => {
                    if (el) el.indeterminate = someOn;
                  }}
                  onChange={() => togglePortal(keys, !allOn)}
                />
                <span className="font-semibold">{portal}</span>
                <span className="text-muted text-[10px]">({keys.length} permission{keys.length === 1 ? '' : 's'})</span>
              </label>
            );
          })}
        </div>
        <p className="text-muted text-[10px] mt-1.5">
          Roles &amp; Access Control, Kiosk Portals, Billing, and Policies are owner-only — they
          can&apos;t be granted here, no matter which permissions are checked below.
        </p>
      </div>

      <div>
        <div className="text-[10px] uppercase tracking-wide text-muted font-bold mb-1.5">Individual permissions</div>
        <div className="grid sm:grid-cols-2 gap-x-6 gap-y-4">
          {groups.map(([grp, rows]) => (
            <div key={grp}>
              <div className="text-[10px] uppercase tracking-wide text-muted font-bold mb-1">{grp}</div>
              <div className="space-y-1">
                {rows.map((p) => (
                  <label key={p.key} className="flex items-center gap-2 text-xs">
                    <input
                      type="checkbox"
                      checked={draft.has(p.key)}
                      onChange={() => toggle(p.key)}
                    />
                    <span className="font-mono text-[11px]">{p.key}</span>
                    <span className="text-muted">— {p.label}</span>
                  </label>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>

      {error && <p className="text-danger text-xs">{error}</p>}
    </div>
  );

  return (
    <div className="space-y-4">
      {canEdit && !creating && (
        <Button onClick={startCreate}>New custom role</Button>
      )}

      {creating && (
        <Card>
          <h2 className="font-bold text-sm">New custom role</h2>
          {picker}
          <div className="flex gap-2 mt-4">
            <Button onClick={saveCreate} disabled={busy}>
              {busy ? 'Saving…' : 'Create role'}
            </Button>
            <Button variant="ghost" onClick={() => setCreating(false)}>
              Cancel
            </Button>
          </div>
        </Card>
      )}

      {roles.map((r) => (
        <Card key={r.id}>
          <div className="flex items-baseline justify-between">
            <span className="font-bold text-sm">{r.name}</span>
            <span className="text-[11px] text-muted font-mono">
              {r.is_system ? 'system' : 'custom'} · {r.key}
            </span>
          </div>

          {editing === r.id ? (
            <>
              {picker}
              <div className="flex gap-2 mt-4">
                <Button onClick={() => saveEdit(r)} disabled={busy}>
                  {busy ? 'Saving…' : 'Save'}
                </Button>
                <Button variant="ghost" onClick={() => setEditing(null)}>
                  Cancel
                </Button>
              </div>
            </>
          ) : (
            <>
              <div className="mt-2">
                {r.permissions.includes('*') ? (
                  <p className="text-xs text-primary font-semibold">Full access</p>
                ) : (
                  <div className="flex flex-wrap gap-1">
                    {r.permissions.map((p) => (
                      <span
                        key={p}
                        className="text-[10px] font-mono bg-main border border-border rounded px-1.5 py-0.5 text-muted"
                      >
                        {p}
                      </span>
                    ))}
                  </div>
                )}
              </div>
              {canEdit && (
                <div className="flex gap-2 mt-3">
                  <Button variant="ghost" onClick={() => startEdit(r)}>
                    Edit permissions
                  </Button>
                  {!r.is_system && (
                    <Button variant="ghost" onClick={() => remove(r)} disabled={busy}>
                      Delete
                    </Button>
                  )}
                </div>
              )}
            </>
          )}
        </Card>
      ))}
    </div>
  );
}
