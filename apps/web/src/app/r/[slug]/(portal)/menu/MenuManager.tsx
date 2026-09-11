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
type ModifierKind = 'required_single' | 'optional_single' | 'multi';
type ModifierOption = {
  id: string;
  name: string;
  price_cents: number;
  is_available: boolean;
  sort_order: number;
};
type ModifierGroup = {
  id: string;
  name: string;
  kind: ModifierKind;
  min_select: number;
  max_select: number | null;
  sort_order: number;
  modifier_options: ModifierOption[];
};
const KIND_LABEL: Record<ModifierKind, string> = {
  required_single: 'Required · pick 1',
  optional_single: 'Optional · pick 1',
  multi: 'Optional · pick several',
};
type Item = {
  id: string;
  name: string;
  price_cents: number;
  is_available: boolean;
  category_id: string | null;
  menu_variants: Variant[];
  modifier_groups: ModifierGroup[];
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
  // per-item "add modifier group" draft
  const [mgDraft, setMgDraft] = useState<
    Record<string, { name: string; kind: ModifierKind; min: string; max: string }>
  >({});
  // per-group "add option" draft
  const [moDraft, setMoDraft] = useState<Record<string, { name: string; price: string }>>({});

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

  async function addModifierGroup(itemId: string) {
    const d = mgDraft[itemId] ?? { name: '', kind: 'multi' as ModifierKind, min: '', max: '' };
    if (!d.name.trim()) {
      setError('Modifier group needs a name.');
      return;
    }
    const min = d.kind === 'required_single' ? 1 : Math.max(0, Number.parseInt(d.min, 10) || 0);
    const max = d.max.trim() ? Math.max(min, Number.parseInt(d.max, 10) || min) : d.kind === 'multi' ? null : 1;
    const ok = await run(() =>
      supabase.from('modifier_groups').insert({
        menu_item_id: itemId,
        name: d.name.trim(),
        kind: d.kind,
        min_select: min,
        max_select: max,
        sort_order: 99,
      }),
    );
    if (ok) setMgDraft((s) => ({ ...s, [itemId]: { name: '', kind: 'multi', min: '', max: '' } }));
  }

  async function addModifierOption(groupId: string) {
    const d = moDraft[groupId] ?? { name: '', price: '' };
    const cents = d.price.trim() ? Math.round(parseFloat(d.price) * 100) : 0;
    if (!d.name.trim() || Number.isNaN(cents) || cents < 0) {
      setError('Option needs a name and a valid price (0 is fine).');
      return;
    }
    const ok = await run(() =>
      supabase.from('modifier_options').insert({ group_id: groupId, name: d.name.trim(), price_cents: cents, sort_order: 99 }),
    );
    if (ok) setMoDraft((s) => ({ ...s, [groupId]: { name: '', price: '' } }));
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

              <div className="border-t border-border p-2.5 space-y-2.5">
                <h3 className="font-bold text-xs text-muted">Modifiers &amp; add-ons</h3>
                {it.modifier_groups
                  .slice()
                  .sort((a, b) => a.sort_order - b.sort_order)
                  .map((g) => {
                    const od = moDraft[g.id] ?? { name: '', price: '' };
                    const setOd = (patch: Partial<typeof od>) =>
                      setMoDraft((s) => ({ ...s, [g.id]: { ...od, ...patch } }));
                    return (
                      <div key={g.id} className="rounded border border-border p-2.5 bg-main/30">
                        <div className="flex items-center justify-between mb-1.5">
                          <span className="text-xs font-bold">
                            {g.name}{' '}
                            <span className="font-normal text-muted">
                              ({KIND_LABEL[g.kind]}
                              {g.kind !== 'required_single' && g.max_select ? `, up to ${g.max_select}` : ''})
                            </span>
                          </span>
                          <Button
                            variant="danger"
                            disabled={busy}
                            onClick={() => run(() => supabase.from('modifier_groups').delete().eq('id', g.id))}
                          >
                            Delete group
                          </Button>
                        </div>
                        {g.modifier_options.length > 0 && (
                          <table className="w-full text-left text-xs mb-2">
                            <tbody>
                              {g.modifier_options
                                .slice()
                                .sort((a, b) => a.sort_order - b.sort_order)
                                .map((o) => (
                                  <tr key={o.id} className="border-b border-border/40 last:border-0">
                                    <td className="py-1.5 font-semibold">{o.name}</td>
                                    <td className="py-1.5 font-mono">
                                      {o.price_cents > 0 ? `+${formatCents(o.price_cents)}` : 'free'}
                                    </td>
                                    <td className="py-1.5">
                                      <span className={o.is_available ? 'text-ok' : 'text-muted'}>
                                        {o.is_available ? 'on' : 'off'}
                                      </span>
                                    </td>
                                    <td className="py-1.5 text-right whitespace-nowrap">
                                      <Button
                                        variant="ghost"
                                        disabled={busy}
                                        onClick={() =>
                                          run(() =>
                                            supabase
                                              .from('modifier_options')
                                              .update({ is_available: !o.is_available })
                                              .eq('id', o.id),
                                          )
                                        }
                                      >
                                        {o.is_available ? 'Off' : 'On'}
                                      </Button>
                                      <Button
                                        variant="danger"
                                        className="ml-1"
                                        disabled={busy}
                                        onClick={() =>
                                          run(() => supabase.from('modifier_options').delete().eq('id', o.id))
                                        }
                                      >
                                        ✕
                                      </Button>
                                    </td>
                                  </tr>
                                ))}
                            </tbody>
                          </table>
                        )}
                        <div className="flex flex-wrap items-end gap-2">
                          <Field label="Option name">
                            <Input
                              className="w-32"
                              value={od.name}
                              onChange={(e) => setOd({ name: e.target.value })}
                              placeholder="Extra cheese"
                            />
                          </Field>
                          <Field label="Extra price">
                            <Input
                              className="w-24"
                              type="number"
                              step="0.01"
                              min="0"
                              value={od.price}
                              onChange={(e) => setOd({ price: e.target.value })}
                              placeholder="0.00"
                            />
                          </Field>
                          <Button variant="ghost" disabled={busy} onClick={() => addModifierOption(g.id)}>
                            + Add option
                          </Button>
                        </div>
                      </div>
                    );
                  })}

                {(() => {
                  const d = mgDraft[it.id] ?? { name: '', kind: 'multi' as ModifierKind, min: '', max: '' };
                  const setD = (patch: Partial<typeof d>) => setMgDraft((s) => ({ ...s, [it.id]: { ...d, ...patch } }));
                  return (
                    <div className="flex flex-wrap items-end gap-2 pt-1">
                      <Field label="New group name">
                        <Input
                          className="w-36"
                          value={d.name}
                          onChange={(e) => setD({ name: e.target.value })}
                          placeholder="Choose Size"
                        />
                      </Field>
                      <Field label="Type">
                        <Select value={d.kind} onChange={(e) => setD({ kind: e.target.value as ModifierKind })}>
                          <option value="required_single">Required — pick 1</option>
                          <option value="optional_single">Optional — pick 1</option>
                          <option value="multi">Optional — pick several</option>
                        </Select>
                      </Field>
                      {d.kind === 'multi' && (
                        <Field label="Max (blank = any)">
                          <Input
                            className="w-20"
                            type="number"
                            min="0"
                            value={d.max}
                            onChange={(e) => setD({ max: e.target.value })}
                          />
                        </Field>
                      )}
                      <Button variant="ghost" disabled={busy} onClick={() => addModifierGroup(it.id)}>
                        + Add group
                      </Button>
                    </div>
                  );
                })()}
              </div>
            </Card>
          );
        })
      )}
    </div>
  );
}
