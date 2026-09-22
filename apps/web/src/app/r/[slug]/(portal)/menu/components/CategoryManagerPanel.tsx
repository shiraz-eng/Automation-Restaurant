'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { X } from 'lucide-react';
import { usePortalSupabase } from '@/components/PortalProvider';
import { Button, Field, Input } from '@/components/ui';
import type { Category, Item } from '../menuTypes';

/** Category CRUD — identical logic to the original inline "Categories" card,
 *  just presented as a focused modal instead of always taking up page space. */
export function CategoryManagerPanel({ categories, items, canEdit, onClose }: { categories: Category[]; items: Item[]; canEdit: boolean; onClose: () => void }) {
  const router = useRouter();
  const supabase = usePortalSupabase();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [newCatName, setNewCatName] = useState('');
  const [catNameDraft, setCatNameDraft] = useState<Record<string, string>>({});
  const sortedCategories = [...categories].sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));

  async function run(fn: () => PromiseLike<{ error: { message: string } | null }>) {
    setBusy(true);
    setError(null);
    const { error } = await fn();
    setBusy(false);
    if (error) {
      setError(error.message);
      return false;
    }
    router.refresh();
    return true;
  }

  async function addCategory(e: React.FormEvent) {
    e.preventDefault();
    if (!newCatName.trim()) return setError('Give the category a name.');
    const nextSort = sortedCategories.length ? Math.max(...sortedCategories.map((c) => c.sort_order ?? 0)) + 1 : 0;
    const ok = await run(() => supabase.from('menu_categories').insert({ name: newCatName.trim(), sort_order: nextSort }));
    if (ok) setNewCatName('');
  }

  async function renameCategory(id: string, current: string) {
    const draft = (catNameDraft[id] ?? current).trim();
    if (!draft || draft === current) return;
    await run(() => supabase.from('menu_categories').update({ name: draft }).eq('id', id));
  }

  async function deleteCategory(id: string, catName: string, itemCount: number) {
    if (itemCount > 0 && !window.confirm(`"${catName}" has ${itemCount} item${itemCount === 1 ? '' : 's'} — they'll become uncategorised, not deleted. Continue?`)) return;
    await run(() => supabase.from('menu_categories').delete().eq('id', id));
  }

  async function moveCategory(index: number, direction: -1 | 1) {
    const other = sortedCategories[index + direction];
    const cur = sortedCategories[index];
    if (!other || !cur) return;
    setBusy(true);
    setError(null);
    const [{ error: e1 }, { error: e2 }] = await Promise.all([
      supabase.from('menu_categories').update({ sort_order: other.sort_order ?? 0 }).eq('id', cur.id),
      supabase.from('menu_categories').update({ sort_order: cur.sort_order ?? 0 }).eq('id', other.id),
    ]);
    setBusy(false);
    if (e1 || e2) {
      setError(e1?.message ?? e2?.message ?? 'Could not reorder.');
      return;
    }
    router.refresh();
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="w-full max-w-md rounded-xl border border-border bg-surface p-5 max-h-[85vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <h2 className="font-black text-sm">Categories</h2>
          <button onClick={onClose} className="text-muted hover:text-body" aria-label="Close">
            <X size={16} />
          </button>
        </div>
        {error && <div className="rounded border border-danger/40 bg-danger/10 text-danger p-2.5 text-xs mb-3">{error}</div>}
        {sortedCategories.length === 0 ? (
          <p className="text-muted text-xs mb-3">No categories yet.</p>
        ) : (
          <div className="space-y-1.5 mb-4">
            {sortedCategories.map((c, i) => {
              const itemCount = items.filter((it) => it.category_id === c.id).length;
              return (
                <div key={c.id} className="flex items-center gap-2">
                  <div className="flex flex-col">
                    <button type="button" disabled={busy || i === 0} onClick={() => moveCategory(i, -1)} className="text-muted text-[10px] leading-none disabled:opacity-30" aria-label="Move up">
                      ▲
                    </button>
                    <button
                      type="button"
                      disabled={busy || i === sortedCategories.length - 1}
                      onClick={() => moveCategory(i, 1)}
                      className="text-muted text-[10px] leading-none disabled:opacity-30"
                      aria-label="Move down"
                    >
                      ▼
                    </button>
                  </div>
                  <Input
                    className="flex-1"
                    value={catNameDraft[c.id] ?? c.name}
                    disabled={!canEdit}
                    onChange={(e) => setCatNameDraft((s) => ({ ...s, [c.id]: e.target.value }))}
                    onBlur={() => renameCategory(c.id, c.name)}
                  />
                  <span className="text-muted text-[11px] w-16 shrink-0">
                    {itemCount} item{itemCount === 1 ? '' : 's'}
                  </span>
                  {canEdit && (
                    <Button variant="danger" disabled={busy} onClick={() => deleteCategory(c.id, c.name, itemCount)}>
                      Delete
                    </Button>
                  )}
                </div>
              );
            })}
          </div>
        )}
        {canEdit && (
          <form onSubmit={addCategory} className="flex items-end gap-2">
            <Field label="New category">
              <Input value={newCatName} onChange={(e) => setNewCatName(e.target.value)} placeholder="Desserts" />
            </Field>
            <Button type="submit" disabled={busy}>
              Add
            </Button>
          </form>
        )}
      </div>
    </div>
  );
}
