'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { usePortalSupabase } from '@/components/PortalProvider';
import { Button, Card, Field, Input, Select } from '@/components/ui';
import { formatCents } from '@/lib/format';

type Category = { id: string; name: string };
type Variant = {
  id: string;
  name: string;
  price_cents: number;
  sku: string | null;
  sort_order: number;
  is_available: boolean;
  track_availability: boolean;
  available_qty: number;
};
type Item = {
  id: string;
  name: string;
  price_cents: number;
  is_available: boolean;
  category_id: string | null;
  menu_variants: Variant[];
};

export function MenuManager({ categories, items }: { categories: Category[]; items: Item[] }) {
  const router = useRouter();
  const supabase = usePortalSupabase();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [name, setName] = useState('');
  const [price, setPrice] = useState('');
  const [categoryId, setCategoryId] = useState('');

  // per-item "add variant" draft
  const [vDraft, setVDraft] = useState<Record<string, { name: string; price: string; sku: string }>>({});

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

  async function addItem(e: React.FormEvent) {
    e.preventDefault();
    const cents = Math.round(parseFloat(price) * 100);
    if (!name.trim() || Number.isNaN(cents) || cents < 0) {
      setError('Enter a name and a valid price.');
      return;
    }
    setBusy(true);
    setError(null);
    const { data: item, error: iErr } = await supabase
      .from('menu_items')
      .insert({ name: name.trim(), price_cents: 0, category_id: categoryId || null, is_available: true })
      .select('id')
      .single();
    if (iErr || !item) {
      setBusy(false);
      setError(iErr?.message ?? 'Could not add item.');
      return;
    }
    const { error: vErr } = await supabase
      .from('menu_variants')
      .insert({ menu_item_id: item.id, name: 'Regular', price_cents: cents, sort_order: 0 });
    setBusy(false);
    if (vErr) {
      setError(vErr.message);
      return;
    }
    setName('');
    setPrice('');
    setCategoryId('');
    router.refresh();
  }

  async function addVariant(itemId: string) {
    const d = vDraft[itemId] ?? { name: '', price: '', sku: '' };
    const cents = Math.round(parseFloat(d.price) * 100);
    if (!d.name.trim() || Number.isNaN(cents) || cents < 0) {
      setError('Variant needs a name and a valid price.');
      return;
    }
    const ok = await run(() =>
      supabase.from('menu_variants').insert({
        menu_item_id: itemId,
        name: d.name.trim(),
        price_cents: cents,
        sku: d.sku.trim() || null,
        sort_order: 99,
      }),
    );
    if (ok) setVDraft((s) => ({ ...s, [itemId]: { name: '', price: '', sku: '' } }));
  }

  return (
    <div className="space-y-6">
      {error && (
        <div className="rounded border border-danger/40 bg-danger/10 text-danger p-3 text-xs">
          {error}
        </div>
      )}

      <Card>
        <h2 className="font-bold mb-3 text-sm">Add item</h2>
        <form onSubmit={addItem} className="grid grid-cols-1 sm:grid-cols-4 gap-3 items-end">
          <Field label="Name">
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="Price (USD)">
            <Input
              type="number"
              step="0.01"
              min="0"
              value={price}
              onChange={(e) => setPrice(e.target.value)}
            />
          </Field>
          <Field label="Category">
            <Select value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
              <option value="">— none —</option>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          </Field>
          <Button type="submit" disabled={busy}>
            Add
          </Button>
        </form>
        <p className="text-[11px] text-muted mt-2">
          Creates the item with a &ldquo;Regular&rdquo; variant at that price. Add sizes/options below.
        </p>
      </Card>

      {items.length === 0 ? (
        <Card className="text-muted text-xs">No items yet.</Card>
      ) : (
        items.map((it) => {
          const d = vDraft[it.id] ?? { name: '', price: '', sku: '' };
          const setD = (patch: Partial<typeof d>) =>
            setVDraft((s) => ({ ...s, [it.id]: { ...d, ...patch } }));
          return (
            <Card key={it.id} className="p-0 overflow-hidden">
              <div className="flex items-center justify-between p-3 border-b border-border">
                <span className="font-black">
                  {it.name}
                  {!it.is_available && <span className="ml-2 text-danger text-xs">hidden</span>}
                </span>
                <div className="flex gap-1.5">
                  <Button
                    variant="ghost"
                    disabled={busy}
                    onClick={() =>
                      run(() =>
                        supabase
                          .from('menu_items')
                          .update({ is_available: !it.is_available })
                          .eq('id', it.id),
                      )
                    }
                  >
                    {it.is_available ? 'Hide item' : 'Show item'}
                  </Button>
                  <Button
                    variant="danger"
                    disabled={busy}
                    onClick={() => run(() => supabase.from('menu_items').delete().eq('id', it.id))}
                  >
                    Delete
                  </Button>
                </div>
              </div>

              <table className="w-full text-left text-xs">
                <thead className="text-muted border-b border-border">
                  <tr>
                    <th className="p-2.5 font-semibold">Variant</th>
                    <th className="p-2.5 font-semibold text-right">Price</th>
                    <th className="p-2.5 font-semibold">SKU</th>
                    <th className="p-2.5 font-semibold">Stock</th>
                    <th className="p-2.5 font-semibold">Status</th>
                    <th className="p-2.5" />
                  </tr>
                </thead>
                <tbody>
                  {it.menu_variants
                    .slice()
                    .sort((a, b) => a.sort_order - b.sort_order)
                    .map((v) => (
                      <tr key={v.id} className="border-b border-border/50 last:border-0">
                        <td className="p-2.5 font-semibold">{v.name}</td>
                        <td className="p-2.5 text-right font-mono">{formatCents(v.price_cents)}</td>
                        <td className="p-2.5 font-mono text-muted">{v.sku ?? '—'}</td>
                        <td className="p-2.5">
                          {v.track_availability ? (
                            <span className={v.available_qty === 0 ? 'text-danger' : ''}>
                              {v.available_qty}
                            </span>
                          ) : (
                            <span className="text-muted">untracked</span>
                          )}
                        </td>
                        <td className="p-2.5">
                          <span className={v.is_available ? 'text-ok' : 'text-muted'}>
                            {v.is_available ? 'on sale' : 'off'}
                          </span>
                        </td>
                        <td className="p-2.5 text-right whitespace-nowrap">
                          <Button
                            variant="ghost"
                            disabled={busy}
                            onClick={() =>
                              run(() =>
                                supabase
                                  .from('menu_variants')
                                  .update({ is_available: !v.is_available })
                                  .eq('id', v.id),
                              )
                            }
                          >
                            {v.is_available ? 'Off' : 'On'}
                          </Button>
                          <Button
                            variant="ghost"
                            className="ml-1"
                            disabled={busy}
                            onClick={() =>
                              run(() =>
                                supabase
                                  .from('menu_variants')
                                  .update({
                                    track_availability: !v.track_availability,
                                  })
                                  .eq('id', v.id),
                              )
                            }
                          >
                            {v.track_availability ? 'Untrack' : 'Track'}
                          </Button>
                          {it.menu_variants.length > 1 && (
                            <Button
                              variant="danger"
                              className="ml-1"
                              disabled={busy}
                              onClick={() =>
                                run(() =>
                                  supabase.from('menu_variants').delete().eq('id', v.id),
                                )
                              }
                            >
                              ✕
                            </Button>
                          )}
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>

              <div className="flex flex-wrap items-end gap-2 p-2.5 bg-main/40">
                <Field label="Variant name">
                  <Input
                    className="w-32"
                    value={d.name}
                    onChange={(e) => setD({ name: e.target.value })}
                    placeholder="345 ml"
                  />
                </Field>
                <Field label="Price">
                  <Input
                    className="w-24"
                    type="number"
                    step="0.01"
                    min="0"
                    value={d.price}
                    onChange={(e) => setD({ price: e.target.value })}
                  />
                </Field>
                <Field label="SKU">
                  <Input
                    className="w-28"
                    value={d.sku}
                    onChange={(e) => setD({ sku: e.target.value })}
                  />
                </Field>
                <Button variant="ghost" disabled={busy} onClick={() => addVariant(it.id)}>
                  + Add variant
                </Button>
              </div>
            </Card>
          );
        })
      )}
    </div>
  );
}
