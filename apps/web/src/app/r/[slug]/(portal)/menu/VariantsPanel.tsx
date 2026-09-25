'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { usePortalSupabase } from '@/components/PortalProvider';
import { Button, Card, Field, Input, Select } from '@/components/ui';
import { formatCents } from '@/lib/format';
import { linkRecipe, unlinkRecipe } from './components/RecipeLinkField';

type RecipeRow = { id: string; name: string; status: string; recipe_type: string; menu_item_id: string | null; variant_id: string | null };

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
 * its own RLS policy or RPC check (tenant-migrations/0058). With recipe
 * permission, each size can be linked to a recipe (link_recipe) when it is
 * added or later from its row — always a deliberate pick.
 */
export function VariantsPanel({
  canCreate,
  canUpdate,
  canArchive,
  canLinkRecipes = false,
}: {
  canCreate: boolean;
  canUpdate: boolean;
  canArchive: boolean;
  canLinkRecipes?: boolean;
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
  const [newRecipe, setNewRecipe] = useState('');
  const [recipes, setRecipes] = useState<RecipeRow[]>([]);
  const [editId, setEditId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [editPrice, setEditPrice] = useState('');
  const [editSku, setEditSku] = useState('');

  const load = useCallback(async () => {
    const [v, m, rc] = await Promise.all([
      supabase
        .from('menu_variants')
        .select('id, menu_item_id, name, price_cents, sku, sort_order, is_available, menu_items(name)')
        .order('sort_order'),
      canCreate ? supabase.from('menu_items').select('id, name').order('name') : Promise.resolve({ data: [], error: null }),
      canLinkRecipes
        ? supabase.from('recipes').select('id, name, status, recipe_type, menu_item_id, variant_id').neq('status', 'archived').order('name')
        : Promise.resolve({ data: [], error: null }),
    ]);
    setRecipes((rc.data ?? []) as RecipeRow[]);
    if (v.error) setError(v.error.message);
    setRows((v.data ?? []) as unknown as VariantRow[]);
    setItems((m.data ?? []) as { id: string; name: string }[]);
    setLoading(false);
  }, [supabase, canCreate, canLinkRecipes]);

  const linkable = useMemo(() => recipes.filter((r) => !r.menu_item_id && r.recipe_type === 'menu_item'), [recipes]);

  async function linkTo(recipeId: string, menuItemId: string, variantId: string) {
    if (!recipeId) return;
    setBusy(true);
    setError(null);
    const err = await linkRecipe(supabase, recipeId, menuItemId, variantId);
    setBusy(false);
    if (err) setError(err);
    await load();
  }

  async function unlink(r: RecipeRow) {
    if (!confirm(`Unlink "${r.name}" from this size? It stops deducting stock; the recipe is kept.`)) return;
    setBusy(true);
    setError(null);
    const err = await unlinkRecipe(supabase, r.id);
    setBusy(false);
    if (err) setError(err);
    await load();
  }

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
    setBusy(true);
    setError(null);
    const { data: created, error: insErr } = await supabase
      .from('menu_variants')
      .insert({ menu_item_id: newItem, name: newName.trim(), price_cents: cents, sort_order: nextSort })
      .select('id')
      .single();
    setBusy(false);
    if (insErr || !created) {
      setError(insErr?.message ?? 'Could not add the variant.');
      return;
    }
    if (newRecipe) {
      const err = await linkRecipe(supabase, newRecipe, newItem, created.id);
      if (err) setError(`Variant added, but its recipe was not linked: ${err}`);
    }
    setNewName('');
    setNewPrice('');
    setNewRecipe('');
    await load();
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
          <form
            onSubmit={create}
            className={`grid grid-cols-2 gap-3 items-end ${canLinkRecipes && linkable.length > 0 ? 'sm:grid-cols-5' : 'sm:grid-cols-4'}`}
          >
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
            {canLinkRecipes && linkable.length > 0 && (
              <Field label="Recipe (optional)">
                <Select value={newRecipe} onChange={(e) => setNewRecipe(e.target.value)}>
                  <option value="">No recipe</option>
                  {linkable.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.name}
                      {r.status === 'draft' ? ' (draft)' : ''}
                    </option>
                  ))}
                </Select>
              </Field>
            )}
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
                  {canLinkRecipes && <th className="p-2.5 font-semibold">Recipe</th>}
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
                      {canLinkRecipes && <td className="p-2.5" />}
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
                      {canLinkRecipes && (
                        <td className="p-2.5">
                          {(() => {
                            const own = recipes.find((x) => x.variant_id === r.id);
                            if (own) {
                              return (
                                <span className="whitespace-nowrap">
                                  <span className="font-semibold">{own.name}</span>
                                  <button onClick={() => unlink(own)} disabled={busy} className="text-danger text-[11px] underline ml-2">
                                    Unlink
                                  </button>
                                </span>
                              );
                            }
                            const dish = recipes.find((x) => x.menu_item_id === r.menu_item_id && !x.variant_id);
                            const fallback = dish ? `Uses ${dish.name}` : 'No recipe';
                            if (linkable.length === 0) return <span className="text-muted">{fallback}</span>;
                            return (
                              <Select
                                value=""
                                disabled={busy}
                                onChange={(e) => linkTo(e.target.value, r.menu_item_id, r.id)}
                                className="text-[11px] py-1"
                                aria-label={`Link a recipe to ${r.name}`}
                              >
                                <option value="">{fallback}</option>
                                {linkable.map((x) => (
                                  <option key={x.id} value={x.id}>
                                    Link {x.name}
                                    {x.status === 'draft' ? ' (draft)' : ''}
                                  </option>
                                ))}
                              </Select>
                            );
                          })()}
                        </td>
                      )}
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
