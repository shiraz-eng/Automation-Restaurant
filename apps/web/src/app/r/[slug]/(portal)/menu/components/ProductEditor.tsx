'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Plus as PlusIcon, Sparkles, Trash2, X } from 'lucide-react';
import { usePortalSupabase } from '@/components/PortalProvider';
import { Button, Field, Input, Select } from '@/components/ui';
import { formatCents } from '@/lib/format';
import {
  KIND_LABEL,
  computedRowsForItem,
  computedStatusForItem,
  dealsForItem,
  ingredientRef,
  itemAvailabilityStatus,
  recipeFoodCost,
  recipeForItem,
  type Category,
  type DealRow,
  type Ingredient,
  type Item,
  type ModifierKind,
  type ProductAvailabilityRow,
  type RecipeRow,
} from '../menuTypes';
import { ImageFallback } from './ImageFallback';
import { StatusPill } from './StatusPill';

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const ACCEPTED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

const CONNECTIONS = [
  { label: 'Customer Menu', href: (slug: string) => `/order/${slug}` },
  { label: 'Orders', href: (slug: string) => `/r/${slug}/orders` },
  { label: 'Recipes & Food Cost', href: (slug: string) => `/r/${slug}/recipes` },
  { label: 'Inventory', href: (slug: string) => `/r/${slug}/inventory` },
  { label: 'Deals', href: (slug: string) => `/r/${slug}/deals` },
  { label: 'Analytics', href: (slug: string) => `/r/${slug}/exports` },
  { label: 'Customer AI', href: (slug: string) => `/r/${slug}/ai` },
];

export function ProductEditor({
  slug,
  item,
  categories,
  ingredients,
  recipes,
  deals,
  availabilityRows,
  stations,
  canEdit,
  canDelete,
  canViewCost,
  onClose,
  onDeleted,
  onDuplicated,
}: {
  slug: string;
  item: Item;
  categories: Category[];
  ingredients: Ingredient[];
  recipes: RecipeRow[];
  deals: DealRow[];
  availabilityRows: ProductAvailabilityRow[];
  /** Existing station names already in use elsewhere on the menu — offered
   *  as autocomplete suggestions so an Owner reuses "Fryer" instead of
   *  accidentally creating "fryer" and "Fryer" as two different stations. */
  stations: string[];
  canEdit: boolean;
  canDelete: boolean;
  canViewCost: boolean;
  onClose: () => void;
  onDeleted: () => void;
  onDuplicated: (newItemId: string) => void;
}) {
  const router = useRouter();
  const supabase = usePortalSupabase();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);

  // Product Information — local draft, batched into one "Save Changes".
  const [name, setName] = useState(item.name);
  const [description, setDescription] = useState(item.description ?? '');
  const [categoryId, setCategoryId] = useState(item.category_id ?? '');
  const [isAvailable, setIsAvailable] = useState(item.is_available);
  const [station, setStation] = useState(item.station ?? '');
  const singleVariant = item.menu_variants.length === 1 ? item.menu_variants[0] : null;
  const [priceStr, setPriceStr] = useState(singleVariant ? (singleVariant.price_cents / 100).toFixed(2) : '');
  const dirty =
    name !== item.name ||
    description !== (item.description ?? '') ||
    categoryId !== (item.category_id ?? '') ||
    isAvailable !== item.is_available ||
    station !== (item.station ?? '') ||
    (singleVariant != null && priceStr !== (singleVariant.price_cents / 100).toFixed(2));

  // Variants / modifiers — same immediate-add drafts the old inline page used.
  const [vDraft, setVDraft] = useState({ name: '', price: '', sku: '' });
  const [mgDraft, setMgDraft] = useState<{ name: string; kind: ModifierKind; max: string }>({
    name: '',
    kind: 'multi',
    max: '',
  });
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

  async function saveChanges() {
    setBusy(true);
    setError(null);
    const { error: itemErr } = await supabase
      .from('menu_items')
      .update({
        name: name.trim(),
        description: description.trim() || null,
        category_id: categoryId || null,
        is_available: isAvailable,
        station: station.trim() || null,
      })
      .eq('id', item.id);
    if (itemErr) {
      setBusy(false);
      setError(itemErr.message);
      return;
    }
    if (singleVariant) {
      const cents = Math.round(parseFloat(priceStr) * 100);
      if (!Number.isNaN(cents) && cents >= 0 && cents !== singleVariant.price_cents) {
        const { error: vErr } = await supabase
          .from('menu_variants')
          .update({ price_cents: cents })
          .eq('id', singleVariant.id);
        if (vErr) {
          setBusy(false);
          setError(vErr.message);
          return;
        }
      }
    }
    setBusy(false);
    router.refresh();
  }

  async function uploadImage(file: File) {
    if (!ACCEPTED_IMAGE_TYPES.includes(file.type)) return setError('Images must be JPG, PNG, or WebP.');
    if (file.size > MAX_IMAGE_BYTES) return setError('Image must be under 5 MB.');
    setUploading(true);
    setError(null);
    const ext = file.name.split('.').pop() ?? 'jpg';
    const path = `${item.id}/${Date.now()}.${ext}`;
    const { error: upErr } = await supabase.storage.from('menu-images').upload(path, file, { upsert: true, contentType: file.type });
    if (upErr) {
      setUploading(false);
      setError(upErr.message);
      return;
    }
    const {
      data: { publicUrl },
    } = supabase.storage.from('menu-images').getPublicUrl(path);
    const { error: dbErr } = await supabase.from('menu_items').update({ image_url: publicUrl }).eq('id', item.id);
    setUploading(false);
    if (dbErr) return setError(dbErr.message);
    router.refresh();
  }

  async function addVariant() {
    const cents = Math.round(parseFloat(vDraft.price) * 100);
    if (!vDraft.name.trim() || Number.isNaN(cents) || cents < 0) return setError('Variant needs a name and a valid price.');
    const ok = await run(() =>
      supabase.from('menu_variants').insert({
        menu_item_id: item.id,
        name: vDraft.name.trim(),
        price_cents: cents,
        sku: vDraft.sku.trim() || null,
        sort_order: 99,
      }),
    );
    if (ok) setVDraft({ name: '', price: '', sku: '' });
  }

  async function addModifierGroup() {
    if (!mgDraft.name.trim()) return setError('Modifier group needs a name.');
    const min = mgDraft.kind === 'required_single' ? 1 : 0;
    const max = mgDraft.max.trim() ? Math.max(min, Number.parseInt(mgDraft.max, 10) || min) : mgDraft.kind === 'multi' ? null : 1;
    const ok = await run(() =>
      supabase.from('modifier_groups').insert({
        menu_item_id: item.id,
        name: mgDraft.name.trim(),
        kind: mgDraft.kind,
        min_select: min,
        max_select: max,
        sort_order: 99,
      }),
    );
    if (ok) setMgDraft({ name: '', kind: 'multi', max: '' });
  }

  async function addModifierOption(groupId: string) {
    const d = moDraft[groupId] ?? { name: '', price: '' };
    const cents = d.price.trim() ? Math.round(parseFloat(d.price) * 100) : 0;
    if (!d.name.trim() || Number.isNaN(cents) || cents < 0) return setError('Option needs a name and a valid price (0 is fine).');
    const ok = await run(() => supabase.from('modifier_options').insert({ group_id: groupId, name: d.name.trim(), price_cents: cents, sort_order: 99 }));
    if (ok) setMoDraft((s) => ({ ...s, [groupId]: { name: '', price: '' } }));
  }

  async function duplicate() {
    setBusy(true);
    setError(null);
    const { data: newItem, error: iErr } = await supabase
      .from('menu_items')
      .insert({
        name: `${item.name} (Copy)`,
        description: item.description,
        category_id: item.category_id,
        image_url: item.image_url,
        station: item.station,
        price_cents: 0,
        is_available: false,
      })
      .select('id')
      .single();
    if (iErr || !newItem) {
      setBusy(false);
      setError(iErr?.message ?? 'Could not duplicate product.');
      return;
    }
    for (const v of item.menu_variants) {
      await supabase.from('menu_variants').insert({
        menu_item_id: newItem.id,
        name: v.name,
        price_cents: v.price_cents,
        sku: null,
        sort_order: v.sort_order,
        is_available: v.is_available,
      });
    }
    for (const g of item.modifier_groups) {
      const { data: newGroup } = await supabase
        .from('modifier_groups')
        .insert({ menu_item_id: newItem.id, name: g.name, kind: g.kind, min_select: g.min_select, max_select: g.max_select, sort_order: g.sort_order })
        .select('id')
        .single();
      if (newGroup) {
        for (const o of g.modifier_options) {
          await supabase.from('modifier_options').insert({ group_id: newGroup.id, name: o.name, price_cents: o.price_cents, sort_order: o.sort_order });
        }
      }
    }
    setBusy(false);
    router.refresh();
    onDuplicated(newItem.id);
  }

  async function deleteProduct() {
    if (!window.confirm(`Delete "${item.name}"? This can't be undone.`)) return;
    const ok = await run(() => supabase.from('menu_items').delete().eq('id', item.id));
    if (ok) onDeleted();
  }

  const status = itemAvailabilityStatus(item, availabilityRows);
  const computed = useMemo(() => computedStatusForItem(availabilityRows, item.id), [availabilityRows, item.id]);
  const computedRows = useMemo(() => computedRowsForItem(availabilityRows, item.id), [availabilityRows, item.id]);
  const recipe = useMemo(() => recipeForItem(recipes, item.id), [recipes, item.id]);
  const previewPrice = singleVariant ? Math.round(parseFloat(priceStr || '0') * 100) || 0 : item.menu_variants[0]?.price_cents ?? 0;
  const cost = recipe ? recipeFoodCost(recipe, previewPrice || null) : null;
  // Base (non-variant-specific) recipe rows only — same simplification
  // KotInspector.tsx already makes for this exact "what does this item
  // consume" summary; the engine itself resolves the full per-variant
  // override rule server-side (recalc_product_availability).
  const baseRecipeComponents = useMemo(
    () => item.recipe_components.filter((rc) => rc.variant_id === null),
    [item.recipe_components],
  );
  const linkedIngredientIds = useMemo(() => {
    const ids = new Set<string>();
    for (const rc of item.recipe_components) ids.add(rc.inventory_item_id);
    return [...ids];
  }, [item.recipe_components]);
  const linkedIngredients = ingredients.filter((i) => linkedIngredientIds.includes(i.id));
  const ingredientCapacity = useMemo(() => {
    const map = new Map<string, number>();
    for (const rc of baseRecipeComponents) {
      const cap = Math.floor(Math.max((ingredients.find((i) => i.id === rc.inventory_item_id)?.stock_qty ?? 0), 0) / rc.qty_per_unit);
      const cur = map.get(rc.inventory_item_id);
      if (cur === undefined || cap < cur) map.set(rc.inventory_item_id, cap);
    }
    return map;
  }, [baseRecipeComponents, ingredients]);
  const linkedDeals = useMemo(() => dealsForItem(deals, item.id), [deals, item.id]);

  return (
    <div className="fixed inset-0 z-40 bg-black/50 flex justify-end" onClick={onClose}>
      <div className="w-full lg:w-[900px] h-full bg-main border-l border-border overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="sticky top-0 z-10 bg-main border-b border-border px-5 py-4 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="text-[10px] uppercase tracking-wide text-muted font-bold">Edit Product</div>
            <h2 className="font-black text-lg truncate">{item.name}</h2>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {canEdit && (
              <Button variant="ghost" disabled={busy} onClick={duplicate}>
                Duplicate
              </Button>
            )}
            {canDelete && (
              <Button variant="danger" disabled={busy} onClick={deleteProduct}>
                Delete
              </Button>
            )}
            <button onClick={onClose} className="text-muted hover:text-body p-1" aria-label="Close">
              <X size={18} />
            </button>
          </div>
        </div>

        {error && <div className="mx-5 mt-4 rounded border border-danger/40 bg-danger/10 text-danger p-3 text-xs">{error}</div>}

        <div className="p-5 lg:grid lg:grid-cols-[1.3fr_1fr] lg:gap-6 lg:items-start">
          {/* ── Main column ─────────────────────────────────────────── */}
          <div className="space-y-6">
            <section>
              <h3 className="font-bold text-sm mb-3">Product Information</h3>
              <div className="flex items-center gap-3 mb-4">
                <div className="w-16 h-16 rounded-lg overflow-hidden border border-border shrink-0">
                  {item.image_url ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={item.image_url} alt="" className="w-full h-full object-cover" />
                  ) : (
                    <ImageFallback className="w-full h-full" />
                  )}
                </div>
                {canEdit && (
                  <div className="flex flex-col gap-1">
                    <label className="text-xs font-semibold text-primary cursor-pointer">
                      {uploading ? 'Uploading…' : item.image_url ? 'Replace image' : 'Upload image'}
                      <input
                        type="file"
                        accept="image/jpeg,image/png,image/webp"
                        className="hidden"
                        disabled={uploading}
                        onChange={(e) => {
                          const file = e.target.files?.[0];
                          e.target.value = '';
                          if (file) uploadImage(file);
                        }}
                      />
                    </label>
                    {item.image_url && (
                      <button
                        onClick={() => run(() => supabase.from('menu_items').update({ image_url: null }).eq('id', item.id))}
                        disabled={busy}
                        className="text-xs font-semibold text-danger text-left"
                      >
                        Remove image
                      </button>
                    )}
                  </div>
                )}
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <Field label="Product Name">
                  <Input value={name} onChange={(e) => setName(e.target.value)} disabled={!canEdit} />
                </Field>
                <Field label="Category">
                  <Select value={categoryId} onChange={(e) => setCategoryId(e.target.value)} disabled={!canEdit}>
                    <option value="">— none —</option>
                    {categories.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </Select>
                </Field>
              </div>

              <div className="mt-3">
                <Field label="Description — shown to customers on the menu">
                  <textarea
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    disabled={!canEdit}
                    rows={2}
                    className="w-full rounded border border-border bg-surface px-2.5 py-1.5 text-xs outline-none focus:border-primary resize-none disabled:opacity-60"
                    placeholder="Crunchy chicken fillet, lettuce and signature sauce in a toasted bun."
                  />
                </Field>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-3">
                <Field label={singleVariant ? 'Base Price' : 'Base Price'}>
                  {singleVariant ? (
                    <Input type="number" step="0.01" min="0" value={priceStr} onChange={(e) => setPriceStr(e.target.value)} disabled={!canEdit} />
                  ) : (
                    <p className="text-muted text-xs py-1.5">Priced via Variants below</p>
                  )}
                </Field>
                <Field label="Availability">
                  <button
                    type="button"
                    disabled={!canEdit}
                    onClick={() => setIsAvailable((v) => !v)}
                    className="flex items-center gap-2 rounded border border-border bg-surface px-2.5 py-1.5 text-xs disabled:opacity-60"
                  >
                    <StatusPill status={isAvailable ? status : 'unavailable'} />
                    <span className="text-muted">{isAvailable ? 'Visible on menu' : 'Hidden from menu'}</span>
                  </button>
                </Field>
                <Field label="Kitchen Station">
                  <Input
                    list={`stations-${item.id}`}
                    value={station}
                    onChange={(e) => setStation(e.target.value)}
                    disabled={!canEdit}
                    placeholder="Fryer, Grill, Drinks…"
                  />
                  <datalist id={`stations-${item.id}`}>
                    {stations.map((s) => (
                      <option key={s} value={s} />
                    ))}
                  </datalist>
                </Field>
              </div>

              {canEdit && (
                <div className="mt-4">
                  <Button disabled={busy || !dirty} onClick={saveChanges}>
                    {busy ? 'Saving…' : 'Save Changes'}
                  </Button>
                </div>
              )}
            </section>

            <section className="pt-5 border-t border-border">
              <h3 className="font-bold text-sm mb-3">Variants</h3>
              {item.menu_variants.length > 0 && (
                <div className="overflow-x-auto mb-3">
                <table className="w-full text-left text-xs">
                  <thead className="text-muted border-b border-border">
                    <tr>
                      <th className="p-2 font-semibold">Variant</th>
                      <th className="p-2 font-semibold text-right">Price</th>
                      <th className="p-2 font-semibold">SKU</th>
                      <th className="p-2 font-semibold">Stock</th>
                      <th className="p-2 font-semibold">Status</th>
                      {canEdit && <th className="p-2" />}
                    </tr>
                  </thead>
                  <tbody>
                    {item.menu_variants
                      .slice()
                      .sort((a, b) => a.sort_order - b.sort_order)
                      .map((v) => (
                        <tr key={v.id} className="border-b border-border/50 last:border-0">
                          <td className="p-2 font-semibold">{v.name}</td>
                          <td className="p-2 text-right font-mono">{formatCents(v.price_cents)}</td>
                          <td className="p-2 font-mono text-muted">{v.sku ?? '—'}</td>
                          <td className="p-2">
                            {v.track_availability ? (
                              <span className={v.available_qty === 0 ? 'text-danger' : ''}>{v.available_qty}</span>
                            ) : (
                              <span className="text-muted">untracked</span>
                            )}
                          </td>
                          <td className="p-2">
                            <span className={v.is_available ? 'text-ok' : 'text-muted'}>{v.is_available ? 'on sale' : 'off'}</span>
                          </td>
                          {canEdit && (
                            <td className="p-2 text-right whitespace-nowrap">
                              <Button
                                variant="ghost"
                                disabled={busy}
                                onClick={() => run(() => supabase.from('menu_variants').update({ is_available: !v.is_available }).eq('id', v.id))}
                              >
                                {v.is_available ? 'Off' : 'On'}
                              </Button>
                              {item.menu_variants.length > 1 && (
                                <Button variant="danger" className="ml-1" disabled={busy} onClick={() => run(() => supabase.from('menu_variants').delete().eq('id', v.id))}>
                                  <Trash2 size={11} />
                                </Button>
                              )}
                            </td>
                          )}
                        </tr>
                      ))}
                  </tbody>
                </table>
                </div>
              )}
              {canEdit && (
                <div className="flex flex-wrap items-end gap-2">
                  <Field label="Variant name">
                    <Input className="w-28" value={vDraft.name} onChange={(e) => setVDraft((s) => ({ ...s, name: e.target.value }))} placeholder="Large" />
                  </Field>
                  <Field label="Price">
                    <Input className="w-20" type="number" step="0.01" min="0" value={vDraft.price} onChange={(e) => setVDraft((s) => ({ ...s, price: e.target.value }))} />
                  </Field>
                  <Field label="SKU">
                    <Input className="w-24" value={vDraft.sku} onChange={(e) => setVDraft((s) => ({ ...s, sku: e.target.value }))} />
                  </Field>
                  <Button variant="ghost" disabled={busy} onClick={addVariant}>
                    <PlusIcon size={12} className="inline mr-1" /> Add Variant
                  </Button>
                </div>
              )}
            </section>

            <section className="pt-5 border-t border-border space-y-3">
              <h3 className="font-bold text-sm">Modifiers &amp; Add-ons</h3>
              {item.modifier_groups
                .slice()
                .sort((a, b) => a.sort_order - b.sort_order)
                .map((g) => {
                  const od = moDraft[g.id] ?? { name: '', price: '' };
                  return (
                    <div key={g.id} className="rounded-lg border border-border p-3 bg-surface">
                      <div className="flex items-center justify-between mb-2">
                        <span className="text-xs font-bold">
                          {g.name}{' '}
                          <span className={`font-semibold ${g.kind === 'required_single' ? 'text-primary' : 'text-muted'}`}>
                            · {KIND_LABEL[g.kind]}
                            {g.kind === 'multi' && g.max_select ? `, up to ${g.max_select}` : ''}
                          </span>
                        </span>
                        {canEdit && (
                          <Button variant="danger" disabled={busy} onClick={() => run(() => supabase.from('modifier_groups').delete().eq('id', g.id))}>
                            Delete group
                          </Button>
                        )}
                      </div>
                      {g.modifier_options.length > 0 && (
                        <div className="space-y-1 mb-2">
                          {g.modifier_options
                            .slice()
                            .sort((a, b) => a.sort_order - b.sort_order)
                            .map((o) => (
                              <div key={o.id} className="flex items-center justify-between text-xs py-1">
                                <span className="font-semibold">{o.name}</span>
                                <span className="flex items-center gap-2">
                                  <span className="font-mono text-muted">{o.price_cents > 0 ? `+${formatCents(o.price_cents)}` : 'free'}</span>
                                  {canEdit && (
                                    <button onClick={() => run(() => supabase.from('modifier_options').delete().eq('id', o.id))} className="text-danger">
                                      <Trash2 size={11} />
                                    </button>
                                  )}
                                </span>
                              </div>
                            ))}
                        </div>
                      )}
                      {canEdit && (
                        <div className="flex flex-wrap items-end gap-2">
                          <Field label="Option name">
                            <Input className="w-28" value={od.name} onChange={(e) => setMoDraft((s) => ({ ...s, [g.id]: { ...od, name: e.target.value } }))} placeholder="Extra cheese" />
                          </Field>
                          <Field label="Extra price">
                            <Input
                              className="w-20"
                              type="number"
                              step="0.01"
                              min="0"
                              value={od.price}
                              onChange={(e) => setMoDraft((s) => ({ ...s, [g.id]: { ...od, price: e.target.value } }))}
                            />
                          </Field>
                          <Button variant="ghost" disabled={busy} onClick={() => addModifierOption(g.id)}>
                            + Add option
                          </Button>
                        </div>
                      )}
                    </div>
                  );
                })}

              {canEdit && (
                <div className="flex flex-wrap items-end gap-2 pt-1">
                  <Field label="New group name">
                    <Input className="w-32" value={mgDraft.name} onChange={(e) => setMgDraft((s) => ({ ...s, name: e.target.value }))} placeholder="Choose Sauce" />
                  </Field>
                  <Field label="Type">
                    <Select value={mgDraft.kind} onChange={(e) => setMgDraft((s) => ({ ...s, kind: e.target.value as ModifierKind }))}>
                      <option value="required_single">Required — pick 1</option>
                      <option value="optional_single">Optional — pick 1</option>
                      <option value="multi">Optional — pick several</option>
                    </Select>
                  </Field>
                  {mgDraft.kind === 'multi' && (
                    <Field label="Max (blank = any)">
                      <Input className="w-16" type="number" min="0" value={mgDraft.max} onChange={(e) => setMgDraft((s) => ({ ...s, max: e.target.value }))} />
                    </Field>
                  )}
                  <Button variant="ghost" disabled={busy} onClick={addModifierGroup}>
                    + Add group
                  </Button>
                </div>
              )}
            </section>
          </div>

          {/* ── Side column: connected RMS panels ──────────────────────── */}
          <div className="space-y-5 mt-6 lg:mt-0">
            <section className="rounded-lg border border-border bg-surface p-4">
              <div className="flex items-center gap-1.5 mb-3">
                <Sparkles size={13} className="text-primary" />
                <h3 className="font-bold text-xs uppercase tracking-wide text-muted">Customer Preview</h3>
              </div>
              <div className="rounded-lg border border-border overflow-hidden bg-main">
                <div className="aspect-[4/3]">
                  {item.image_url ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={item.image_url} alt="" className="w-full h-full object-cover" />
                  ) : (
                    <ImageFallback className="w-full h-full" />
                  )}
                </div>
                <div className="p-3">
                  <div className="font-bold text-sm">{name || 'Untitled product'}</div>
                  {description && <p className="text-muted text-[11px] mt-0.5 line-clamp-2">{description}</p>}
                  <div className="flex items-center justify-between mt-2">
                    <span className="font-black text-sm">
                      {item.menu_variants.length > 1 ? `from ${formatCents(previewPrice)}` : formatCents(previewPrice)}
                    </span>
                    <span className="rounded-full bg-primary text-primary-fg text-xs font-bold px-3 py-1">Add</span>
                  </div>
                </div>
              </div>
              <p className="text-muted text-[10.5px] mt-2">Exactly how this product appears on the live Customer Menu.</p>
            </section>

            <section className="rounded-lg border border-border bg-surface p-4">
              <h3 className="font-bold text-xs uppercase tracking-wide text-muted mb-3">Recipe &amp; Food Cost</h3>
              {recipe ? (
                <div className="space-y-1.5 text-xs">
                  <div className="font-semibold">{recipe.name}</div>
                  {canViewCost && cost && (
                    <>
                      <div className="flex justify-between">
                        <span className="text-muted">Food Cost</span>
                        <span className={`font-mono font-bold ${cost.foodCostPct != null && cost.foodCostPct > 35 ? 'text-warn' : 'text-body'}`}>
                          {cost.foodCostPct != null ? `${cost.foodCostPct}%` : '—'}
                        </span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-muted">Cost</span>
                        <span className="font-mono">{formatCents(cost.costCents)}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-muted">Selling Price</span>
                        <span className="font-mono">{formatCents(previewPrice)}</span>
                      </div>
                    </>
                  )}
                </div>
              ) : (
                <p className="text-muted text-xs">No recipe linked yet.</p>
              )}
              <Link href={`/r/${slug}/recipes`} className="text-primary text-xs font-semibold hover:underline mt-3 inline-block">
                View Recipe →
              </Link>
            </section>

            <section className="rounded-lg border border-border bg-surface p-4">
              <h3 className="font-bold text-xs uppercase tracking-wide text-muted mb-3">Inventory &amp; Producible Qty</h3>
              {computed ? (
                <div className={`rounded border p-2.5 text-xs mb-3 ${computed.status === 'unavailable' ? 'border-danger/30 bg-danger/10' : computed.status === 'low_stock' ? 'border-warn/30 bg-warn/10' : 'border-ok/30 bg-ok/10'}`}>
                  <div className="flex items-center justify-between">
                    <span className="font-bold">
                      {computed.status === 'unavailable' ? 'Cannot be made right now' : computed.status === 'low_stock' ? 'Producible, but low' : 'Fully producible'}
                    </span>
                    <span className="font-mono font-semibold">{computed.producibleQty ?? '—'} left</span>
                  </div>
                  {computed.reason && <div className="text-muted mt-1">{computed.reason}</div>}
                  {item.menu_variants.length > 1 && (
                    <div className="mt-2 pt-2 border-t border-border/60 space-y-1">
                      {computedRows.map((r) => {
                        const v = item.menu_variants.find((mv) => mv.id === r.variant_id);
                        if (!v) return null;
                        return (
                          <div key={r.variant_id} className="flex items-center justify-between">
                            <span>{v.name}</span>
                            <span className={r.status === 'unavailable' ? 'text-danger font-semibold' : r.status === 'low_stock' ? 'text-warn font-semibold' : 'text-ok font-semibold'}>
                              {r.producible_qty ?? '—'} left
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              ) : (
                linkedIngredients.length > 0 && (
                  <p className="text-muted text-[11px] mb-3">No recipe-driven producible-qty tracking yet — link ingredients on the Recipes page to enable it.</p>
                )
              )}
              {linkedIngredients.length > 0 ? (
                <div className="space-y-1.5">
                  {linkedIngredients.map((ing) => {
                    const low = ing.stock_qty <= ing.min_threshold;
                    const cap = ingredientCapacity.get(ing.id);
                    const isBottleneck = computed && cap !== undefined && cap === computed.producibleQty && (computed.status === 'unavailable' || computed.status === 'low_stock');
                    return (
                      <div key={ing.id} className="flex items-center justify-between text-xs">
                        <span className={isBottleneck ? 'font-semibold' : ''}>
                          {ing.name}
                          {isBottleneck && <span className="text-danger ml-1">(bottleneck)</span>}
                        </span>
                        <span className="flex items-center gap-2">
                          {cap !== undefined && <span className="font-mono text-muted">{cap} portions</span>}
                          <span className={low ? 'text-warn font-semibold' : 'text-ok font-semibold'}>{low ? 'Low Stock' : 'Available'}</span>
                        </span>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <p className="text-muted text-xs">No linked ingredients.</p>
              )}
              <Link href={`/r/${slug}/inventory`} className="text-primary text-xs font-semibold hover:underline mt-3 inline-block">
                View Inventory →
              </Link>
            </section>

            <section className="rounded-lg border border-border bg-surface p-4">
              <h3 className="font-bold text-xs uppercase tracking-wide text-muted mb-3">Active Deal</h3>
              {linkedDeals.length > 0 ? (
                <div className="space-y-2">
                  {linkedDeals.map(({ deal }) => (
                    <div key={deal.id} className="flex items-center justify-between text-xs">
                      <span className="font-semibold">{deal.name}</span>
                      <span className="font-mono text-primary">{formatCents(deal.price_cents)}</span>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-muted text-xs">Not part of any active deal.</p>
              )}
              <Link href={`/r/${slug}/deals`} className="text-primary text-xs font-semibold hover:underline mt-3 inline-block">
                View Deals →
              </Link>
            </section>

            <section className="rounded-lg border border-border bg-surface p-4">
              <h3 className="font-bold text-xs uppercase tracking-wide text-muted mb-3">This Product Connects To</h3>
              <div className="flex flex-wrap gap-1.5">
                {CONNECTIONS.map((c) => (
                  <Link
                    key={c.label}
                    href={c.href(slug)}
                    className="inline-flex items-center gap-1 rounded-full border border-border bg-main px-2.5 py-1 text-[11px] font-semibold hover:border-primary/40 transition-colors"
                  >
                    <span className="w-1.5 h-1.5 rounded-full bg-primary" />
                    {c.label}
                  </Link>
                ))}
              </div>
            </section>
          </div>
        </div>
      </div>
    </div>
  );
}
