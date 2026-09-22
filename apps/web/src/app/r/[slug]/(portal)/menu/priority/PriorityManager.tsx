'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { GripVertical, X } from 'lucide-react';
import { usePortalSupabase } from '@/components/PortalProvider';
import { Button, Field, Select } from '@/components/ui';

type Ref<T> = T | T[] | null;
function one<T>(x: Ref<T>): T | null {
  return Array.isArray(x) ? (x[0] ?? null) : x;
}

export type PriorityLevel = 'critical' | 'high' | 'medium' | 'low';
export type PriorityRow = {
  id: string;
  menu_item_id: string;
  priority_level: PriorityLevel;
  priority_rank: number;
  updated_at: string;
  menu_items: Ref<{ name: string; category_id: string | null }>;
};
export type MenuItemOption = { id: string; name: string; category_id: string | null };
export type AvailabilityRow = {
  menu_item_id: string;
  variant_id: string | null;
  status: 'available' | 'low_stock' | 'unavailable';
  producible_qty: number | null;
  reason: string | null;
};

const LEVELS: { key: PriorityLevel; label: string; tone: string }[] = [
  { key: 'critical', label: 'Critical', tone: 'border-danger/40 bg-danger/5' },
  { key: 'high', label: 'High', tone: 'border-warn/40 bg-warn/5' },
  { key: 'medium', label: 'Medium', tone: 'border-primary/30 bg-primary/5' },
  { key: 'low', label: 'Low', tone: 'border-border bg-surface' },
];
const STATUS_TONE: Record<string, string> = { available: 'text-ok bg-ok/10', low_stock: 'text-warn bg-warn/10', unavailable: 'text-danger bg-danger/10' };
const STATUS_LABEL: Record<string, string> = { available: 'Available', low_stock: 'Low Stock', unavailable: 'Unavailable' };

/** Worst-case computed status across every tracked variant of this item —
 *  same "combine at the read layer" rule Menu Management's own
 *  computedStatusForItem() uses, kept local here to avoid a cross-directory
 *  type dependency for what's otherwise a self-contained page. */
function statusForItem(rows: AvailabilityRow[], itemId: string): { status: string; producibleQty: number | null; reason: string | null } | null {
  const forItem = rows.filter((r) => r.menu_item_id === itemId);
  if (forItem.length === 0) return null;
  if (forItem.every((r) => r.status === 'unavailable')) return { status: 'unavailable', producibleQty: 0, reason: forItem[0].reason };
  const issue = forItem.find((r) => r.status !== 'available');
  if (issue) return { status: 'low_stock', producibleQty: issue.producible_qty, reason: issue.reason };
  const total = forItem.reduce((s, r) => s + (r.producible_qty ?? 0), 0);
  return { status: 'available', producibleQty: total, reason: null };
}

export function PriorityManager({
  slug: _slug,
  priorities,
  menuItems,
  availability,
  canManage,
}: {
  slug: string;
  priorities: PriorityRow[];
  menuItems: MenuItemOption[];
  availability: AvailabilityRow[];
  canManage: boolean;
}) {
  const router = useRouter();
  const supabase = usePortalSupabase();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [addPick, setAddPick] = useState('');
  const [addLevel, setAddLevel] = useState<PriorityLevel>('medium');
  const [dragId, setDragId] = useState<string | null>(null);

  useEffect(() => {
    const channel = supabase
      .channel('priority-allocation')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'product_priority' }, () => router.refresh())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'product_availability' }, () => router.refresh())
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [supabase, router]);

  const menuItemById = useMemo(() => new Map(menuItems.map((m) => [m.id, m])), [menuItems]);
  const prioritizedIds = useMemo(() => new Set(priorities.map((p) => p.menu_item_id)), [priorities]);
  const unprioritized = useMemo(
    () => menuItems.filter((m) => !prioritizedIds.has(m.id)).sort((a, b) => a.name.localeCompare(b.name)),
    [menuItems, prioritizedIds],
  );
  const byLevel = useMemo(() => {
    const m = new Map<PriorityLevel, PriorityRow[]>();
    for (const level of LEVELS) m.set(level.key, []);
    for (const p of priorities) m.get(p.priority_level)?.push(p);
    for (const rows of m.values()) rows.sort((a, b) => a.priority_rank - b.priority_rank);
    return m;
  }, [priorities]);

  async function run(fn: () => PromiseLike<{ error: { message: string } | null }>) {
    setBusy(true);
    setError(null);
    const { error: e } = await fn();
    setBusy(false);
    if (e) {
      setError(e.message);
      return false;
    }
    router.refresh();
    return true;
  }

  async function addToPriority() {
    if (!addPick) return;
    await run(() => supabase.rpc('set_product_priority', { p_menu_item_id: addPick, p_priority_level: addLevel }));
    setAddPick('');
  }
  async function changeLevel(menuItemId: string, level: PriorityLevel) {
    await run(() => supabase.rpc('set_product_priority', { p_menu_item_id: menuItemId, p_priority_level: level }));
  }
  async function remove(menuItemId: string) {
    await run(() => supabase.rpc('remove_product_priority', { p_menu_item_id: menuItemId }));
  }
  async function dropOn(level: PriorityLevel, targetMenuItemId: string | null) {
    if (!dragId) return;
    const current = (byLevel.get(level) ?? []).map((r) => r.menu_item_id);
    // The dragged item may be arriving from a different level — set_product_
    // priority first ensures it's in THIS level's list before reordering it.
    let ids = current.includes(dragId) ? current : [...current, dragId];
    ids = ids.filter((id) => id !== dragId);
    const targetIdx = targetMenuItemId ? ids.indexOf(targetMenuItemId) : ids.length;
    ids.splice(targetIdx < 0 ? ids.length : targetIdx, 0, dragId);
    setDragId(null);

    if (!current.includes(dragId)) {
      const ok = await run(() => supabase.rpc('set_product_priority', { p_menu_item_id: dragId, p_priority_level: level }));
      if (!ok) return;
    }
    await run(() => supabase.rpc('reorder_product_priority', { p_priority_level: level, p_ordered_menu_item_ids: ids }));
  }

  return (
    <div className="space-y-5">
      {error && <div className="rounded border border-danger/40 bg-danger/10 text-danger p-3 text-xs">{error}</div>}

      {canManage && (
        <div className="rounded-lg border border-border bg-surface p-4">
          <h2 className="font-bold text-sm mb-3">Add a product to the priority list</h2>
          <div className="flex flex-wrap gap-3 items-end">
            <Field label="Product">
              <Select value={addPick} onChange={(e) => setAddPick(e.target.value)} className="w-56">
                <option value="">Choose a product…</option>
                {unprioritized.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Level">
              <Select value={addLevel} onChange={(e) => setAddLevel(e.target.value as PriorityLevel)} className="w-32">
                {LEVELS.map((l) => (
                  <option key={l.key} value={l.key}>
                    {l.label}
                  </option>
                ))}
              </Select>
            </Field>
            <Button onClick={addToPriority} disabled={!addPick || busy}>
              Add
            </Button>
          </div>
          {unprioritized.length === 0 && menuItems.length > 0 && (
            <p className="text-muted text-[11px] mt-2">Every product already has a priority set.</p>
          )}
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        {LEVELS.map((level) => {
          const rows = byLevel.get(level.key) ?? [];
          return (
            <div
              key={level.key}
              className={`rounded-lg border p-3 min-h-[120px] ${level.tone}`}
              onDragOver={(e) => canManage && e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                if (canManage) dropOn(level.key, null);
              }}
            >
              <div className="flex items-center justify-between mb-2">
                <h3 className="font-bold text-xs uppercase tracking-wide">{level.label}</h3>
                <span className="text-[10px] text-muted">{rows.length}</span>
              </div>
              {rows.length === 0 ? (
                <p className="text-muted text-[11px] py-3 text-center">Drop a product here, or add one above.</p>
              ) : (
                <div className="space-y-1.5">
                  {rows.map((r) => {
                    const item = one(r.menu_items) ?? menuItemById.get(r.menu_item_id);
                    const a = statusForItem(availability, r.menu_item_id);
                    return (
                      <div
                        key={r.id}
                        draggable={canManage}
                        onDragStart={() => setDragId(r.menu_item_id)}
                        onDragOver={(e) => canManage && e.preventDefault()}
                        onDrop={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          if (canManage) dropOn(level.key, r.menu_item_id);
                        }}
                        className="rounded border border-border bg-surface px-2.5 py-2 text-xs space-y-1.5"
                      >
                        <div className="flex items-center gap-1.5 min-w-0">
                          {canManage && <GripVertical size={13} className="text-muted shrink-0 cursor-grab" />}
                          <span className="font-semibold truncate">{item?.name ?? '—'}</span>
                        </div>
                        <div className="flex items-center gap-1.5 flex-wrap">
                          {a && (
                            <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-bold ${STATUS_TONE[a.status] ?? ''}`} title={a.reason ?? undefined}>
                              {STATUS_LABEL[a.status] ?? a.status}
                              {a.producibleQty != null ? ` · ${a.producibleQty}` : ''}
                            </span>
                          )}
                          {canManage && (
                            <>
                              <Select
                                value={r.priority_level}
                                onChange={(e) => changeLevel(r.menu_item_id, e.target.value as PriorityLevel)}
                                className="text-[10px] py-0.5 w-20 ml-auto"
                              >
                                {LEVELS.map((l) => (
                                  <option key={l.key} value={l.key}>
                                    {l.label}
                                  </option>
                                ))}
                              </Select>
                              <button onClick={() => remove(r.menu_item_id)} className="text-danger shrink-0" aria-label={`Remove ${item?.name ?? ''} from priority list`}>
                                <X size={13} />
                              </button>
                            </>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {unprioritized.length > 0 && (
        <div className="rounded-lg border border-border bg-surface p-4">
          <h3 className="font-bold text-xs uppercase tracking-wide text-muted mb-2">Not prioritized ({unprioritized.length})</h3>
          <p className="text-muted text-[11px] mb-2">
            These products still get the recipe-driven engine&rsquo;s normal, independent availability calculation
            unless a shared ingredient is also claimed by a prioritized product above — in that case, they&rsquo;re
            served last, from whatever&rsquo;s left.
          </p>
          <div className="flex flex-wrap gap-1.5">
            {unprioritized.map((m) => (
              <span key={m.id} className="rounded-full border border-border px-2.5 py-1 text-[11px]">
                {m.name}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
