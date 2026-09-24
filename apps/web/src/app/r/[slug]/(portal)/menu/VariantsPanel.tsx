'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { usePortalSupabase } from '@/components/PortalProvider';
import { Button, Card, Field, Input, Select } from '@/components/ui';
import { formatCents } from '@/lib/format';

type VariantRow = {
  id: string;
  menu_item_id: string;
  name: string;
  price_cents: number;
  sku: string | null;
  sort_order: number;
  is_available: boolean;
  menu_items: { name: string } | { name: string }[] | null;
};

function itemName(v: VariantRow): string {
  const m = Array.isArray(v.menu_items) ? v.menu_items[0] : v.menu_items;
  return m?.name ?? '—';
}

/**
 * Sizes/portions of each menu item. variants.view lists them,
 * variants.create adds one, variants.update edits name/price/SKU and
 * variants.archive takes one off sale (set_variant_archived). Each maps to
 * its own RLS policy or RPC check (tenant-migrations/0058).
 */
export function VariantsPanel({
  canCreate,
  canUpdate,
  canArchive,
}: {
  canCreate: boolean;
  canUpdate: boolean;
  canArchive: boolean;
}) {
  const supabase = usePortalSupabase();
  const [rows, setRows] = useState<VariantRow[]>([]);
  const [items, setItems] = useState<{ id: string; name: string }[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState('');
  const [newItem, setNewItem] = useState('');
  const [newName, setNewName] = useState('');
  const [newPrice, setNewPrice] = useState('');
  const [editId, setEditId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [editPrice, setEditPrice] = useState('');
  const [editSku, setEditSku] = useState('');

  const load = useCallback(async () => {
    const [v, m] = await Promise.all([
      supabase
        .from('menu_variants')
        .select('id, menu_item_id, name, price_cents, sku, sort_order, is_available, menu_items(name)')
        .order('sort_order'),
      canCreate ? supabase.from('menu_items').select('id, name').order('name') : Promise.resolve({ data: [], error: null }),
    ]);
    if (v.error) setError(v.error.message);
    setRows((v.data ?? []) as unknown as VariantRow[]);
    setItems((m.data ?? []) as { id: string; name: string }[]);
    setLoading(false);
  }, [supabase, canCreate]);

  useEffect(() => {
    void load();
  }, [load]);

  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return rows
      .filter((r) => !q || `${itemName(r)} ${r.name} ${r.sku ?? ''}`.toLowerCase().includes(q))
      .sort((a, b) => itemName(a).localeCompare(itemName(b)) || a.sort_order - b.sort_order);
  }, [rows, filter]);

  async function run(fn: () => PromiseLike<{ error: { message: string } | null }>) {
    setBusy(true);
    setError(null);
    const { error: e } = await fn();
    setBusy(false);
    if (e) {
      setError(e.message);
      return false;
    }
    await load();
    return true;
  }

  async function create(e: React.FormEvent) {
    e.preventDefault();
    const cents = Math.round(parseFloat(newPrice) * 100);
    if (!newItem || !newName.trim() || !Number.isFinite(cents) || cents < 0) {
      setError('Choose an item and enter a name and price.');
      return;
    }
    const nextSort = rows.filter((r) => r.menu_item_id === newItem).length;
    const ok = await run(() =>
      supabase.from('menu_variants').insert({ menu_item_id: newItem, name: newName.trim(), price_cents: cents, sort_order: nextSort }),
    );
    if (ok) {
      setNewName('');
      setNewPrice('');
    }
  }

  function startEdit(r: VariantRow) {
    setEditId(r.id);
    setEditName(r.name);
    setEditPrice((r.price_cents / 100).toFixed(2));
    setEditSku(r.sku ?? '');
  }

  async function saveEdit() {
    if (!editId) return;
    const cents = Math.round(parseFloat(editPrice) * 100);
    if (!editName.trim() || !Number.isFinite(cents) || cents < 0) {
      setError('Enter a name and a valid price.');
      return;
    }
    const ok = await run(() =>
      supabase
        .from('menu_variants')
        .update({ name: editName.trim(), price_cents: cents, sku: editSku.trim() || null })
        .eq('id', editId),
    );
    if (ok) setEditId(null);
  }

  return (
    <div className="space-y-3">
      {canCreate && (
        <Card>
          <h3 className="font-bold text-sm mb-3">Add a variant</h3>
          <form onSubmit={create} className="grid grid-cols-2 sm:grid-cols-4 gap-3 items-end">
            <Field label="Menu item">
              <Select value={newItem} onChange={(e) => setNewItem(e.target.value)}>
                <option value="">Choose…</option>
                {items.map((i) => (
                  <option key={i.id} value={i.id}>
                    {i.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Name">
              <Input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="Large" />
            </Field>
            <Field label="Price">
              <Input type="number" step="0.01" min="0" value={newPrice} onChange={(e) => setNewPrice(e.target.value)} />
            </Field>
            <Button type="submit" disabled={busy}>
              Add
            </Button>
          </form>
        </Card>
      )}

      <Card className="p-0 overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-2 p-3 border-b border-border">
          <h3 className="font-bold text-sm">Variants</h3>
          <Input placeholder="Search" value={filter} onChange={(e) => setFilter(e.target.value)} className="w-48" />
        </div>
        {error && <div className="bg-danger/10 text-danger text-xs p-3">{error}</div>}
        {loading ? (
          <p className="p-3 text-muted text-xs">Loading…</p>
        ) : shown.length === 0 ? (
          <p className="p-3 text-muted text-xs">No variants.</p>
        ) : (
          <div className="max-h-[28rem] overflow-y-auto">
            <table className="w-full text-left text-xs">
              <thead className="text-muted border-b border-border sticky top-0 bg-surface">
                <tr>
                  <th className="p-2.5 font-semibold">Item</th>
                  <th className="p-2.5 font-semibold">Variant</th>
                  <th className="p-2.5 font-semibold">SKU</th>
                  <th className="p-2.5 font-semibold text-right">Price</th>
                  <th className="p-2.5 font-semibold">Status</th>
                  <th className="p-2.5" />
                </tr>
              </thead>
              <tbody>
                {shown.map((r) =>
                  editId === r.id ? (
                    <tr key={r.id} className="border-b border-border/60 bg-main/40">
                      <td className="p-2.5">{itemName(r)}</td>
                      <td className="p-2.5">
                        <Input value={editName} onChange={(e) => setEditName(e.target.value)} />
                      </td>
                      <td className="p-2.5">
                        <Input value={editSku} onChange={(e) => setEditSku(e.target.value)} />
                      </td>
                      <td className="p-2.5">
                        <Input type="number" step="0.01" min="0" value={editPrice} onChange={(e) => setEditPrice(e.target.value)} />
                      </td>
                      <td className="p-2.5" />
                      <td className="p-2.5 text-right whitespace-nowrap">
                        <Button disabled={busy} onClick={saveEdit}>
                          Save
                        </Button>
                        <Button variant="ghost" className="ml-1.5" onClick={() => setEditId(null)}>
                          Cancel
                        </Button>
                      </td>
                    </tr>
                  ) : (
                    <tr key={r.id} className="border-b border-border/60 last:border-0">
                      <td className="p-2.5 font-semibold">{itemName(r)}</td>
                      <td className="p-2.5">{r.name}</td>
                      <td className="p-2.5 font-mono text-muted">{r.sku ?? '—'}</td>
                      <td className="p-2.5 text-right tabular-nums">{formatCents(r.price_cents)}</td>
                      <td className="p-2.5">
                        <span className={r.is_available ? 'text-ok' : 'text-muted'}>{r.is_available ? 'on sale' : 'archived'}</span>
                      </td>
                      <td className="p-2.5 text-right whitespace-nowrap">
                        {canUpdate && (
                          <Button variant="ghost" disabled={busy} onClick={() => startEdit(r)}>
                            Edit
                          </Button>
                        )}
                        {canArchive && (
                          <Button
                            variant={r.is_available ? 'danger' : 'ghost'}
                            className="ml-1.5"
                            disabled={busy}
                            onClick={() =>
                              run(() => supabase.rpc('set_variant_archived', { p_variant_id: r.id, p_archived: r.is_available }))
                            }
                          >
                            {r.is_available ? 'Archive' : 'Restore'}
                          </Button>
                        )}
                      </td>
                    </tr>
                  ),
                )}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
