'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { usePortalSupabase } from '@/components/PortalProvider';
import { Button, Card, Input } from '@/components/ui';

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
    <div className="mt-3 space-y-3">
      <Input
        placeholder="Role name"
        value={draftName}
        onChange={(e) => setDraftName(e.target.value)}
        className="max-w-xs"
      />
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
