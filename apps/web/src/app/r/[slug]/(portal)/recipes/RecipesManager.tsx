'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { usePortalSupabase } from '@/components/PortalProvider';
import { Button, Card, Field, Input, Select } from '@/components/ui';
import { formatCents } from '@/lib/format';

export type InventoryItemOption = { id: string; name: string; unit: string; cost_cents_per_base_unit?: number };
export type MenuItemOption = {
  id: string;
  name: string;
  price_cents: number;
  menu_variants: { id: string; name: string; price_cents: number }[];
};
export type SubRecipeOption = {
  id: string;
  name: string;
  current_version_id: string | null;
  recipe_versions: { yield_qty: number; yield_unit: string | null } | { yield_qty: number; yield_unit: string | null }[] | null;
};
export type CategoryOption = { id: string; name: string };

type Ref<T> = T | T[] | null;
function one<T>(x: Ref<T>): T | null {
  if (!x) return null;
  return Array.isArray(x) ? (x[0] ?? null) : x;
}

type IngredientRow = {
  id: string;
  qty_base: number;
  sort_order: number;
  inventory_item_id: string | null;
  sub_recipe_id: string | null;
  inventory_items: Ref<{ name: string; unit: string; cost_cents_per_base_unit: number }>;
  recipes: Ref<{ name: string }>;
};
type CostLogRow = { cost_cents: number; recorded_at: string };
type VersionRow = {
  id: string;
  version: number;
  status: 'draft' | 'active' | 'archived';
  yield_qty: number;
  yield_unit: string | null;
  effective_from: string | null;
  effective_to: string | null;
  recipe_ingredients: IngredientRow[];
  recipe_cost_log: CostLogRow[];
};
export type Recipe = {
  id: string;
  name: string;
  description: string | null;
  notes: string | null;
  recipe_type: 'menu_item' | 'variant' | 'semi_finished' | 'preparation';
  status: 'draft' | 'active' | 'archived';
  instructions: string | null;
  current_version_id: string | null;
  created_at: string;
  menu_item_id: string | null;
  variant_id: string | null;
  // menu_items.price_cents is vestigial in this schema — the real price
  // always lives on menu_variants, hence the nested variant list here.
  menu_items: Ref<{ name: string; menu_variants: { name: string; price_cents: number; sort_order: number }[] }>;
  menu_variants: Ref<{ name: string; price_cents: number }>;
  recipe_versions: VersionRow[];
};

/** The menu price this recipe should be measured against: its own linked
 *  variant's price for a variant-specific recipe, else the linked item's
 *  first (lowest sort_order) variant for a base menu_item recipe — the
 *  same "from $X" convention the storefront uses for a multi-variant item. */
function menuPriceFor(recipe: Recipe): number | null {
  const ownVariant = one(recipe.menu_variants);
  if (ownVariant) return ownVariant.price_cents;
  const item = one(recipe.menu_items);
  const variants = (item?.menu_variants ?? []).slice().sort((a, b) => a.sort_order - b.sort_order);
  return variants[0]?.price_cents ?? null;
}

const TYPE_LABELS: Record<Recipe['recipe_type'], string> = {
  menu_item: 'Menu Item',
  variant: 'Variant',
  semi_finished: 'Semi-Finished',
  preparation: 'Preparation',
};

/** Mirrors recipe_version_total_cost()/resolve_recipe_ingredients() for
 *  instant display without an extra round trip per recipe — the RPC stays
 *  authoritative for anything that actually activates or gets stored;
 *  this is a provisional preview, same convention as the storefront cart
 *  showing a provisional total the server always re-computes for real. */
function computeCost(recipeId: string, byId: Map<string, Recipe>, visited: Set<string> = new Set()): number | null {
  if (visited.has(recipeId)) return null;
  visited.add(recipeId);
  const recipe = byId.get(recipeId);
  if (!recipe?.current_version_id) return null;
  const version = recipe.recipe_versions.find((v) => v.id === recipe.current_version_id);
  if (!version) return null;
  let total = 0;
  for (const ing of version.recipe_ingredients) {
    if (ing.inventory_item_id) {
      const inv = one(ing.inventory_items);
      total += Math.round(ing.qty_base * (inv?.cost_cents_per_base_unit ?? 0));
    } else if (ing.sub_recipe_id) {
      const subRecipe = byId.get(ing.sub_recipe_id);
      const subVersion = subRecipe?.recipe_versions.find((v) => v.id === subRecipe.current_version_id);
      const subCost = computeCost(ing.sub_recipe_id, byId, visited);
      if (subCost != null && subVersion) {
        total += Math.round((ing.qty_base * subCost) / Math.max(subVersion.yield_qty, 0.0001));
      }
    }
  }
  return total;
}

function costPerYieldUnit(recipe: Recipe, byId: Map<string, Recipe>): number | null {
  const version = recipe.recipe_versions.find((v) => v.id === recipe.current_version_id);
  if (!version) return null;
  const total = computeCost(recipe.id, byId);
  if (total == null) return null;
  return Math.round(total / Math.max(version.yield_qty, 0.0001));
}

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

type DraftIngredient = { key: string; kind: 'inventory' | 'sub_recipe'; refId: string; qty_base: string };

export function RecipesManager({
  recipes,
  menuItems,
  inventoryItems,
  subRecipes,
  categories,
  canManage,
  canViewCost,
}: {
  recipes: Recipe[];
  menuItems: MenuItemOption[];
  inventoryItems: InventoryItemOption[];
  subRecipes: SubRecipeOption[];
  categories: CategoryOption[];
  canManage: boolean;
  canViewCost: boolean;
}) {
  const router = useRouter();
  const supabase = usePortalSupabase();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [showCreate, setShowCreate] = useState(false);
  const [newVersionFor, setNewVersionFor] = useState<Recipe | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [minFoodCost, setMinFoodCost] = useState('');

  const byId = useMemo(() => new Map(recipes.map((r) => [r.id, r])), [recipes]);
  const inventoryById = useMemo(() => new Map(inventoryItems.map((i) => [i.id, i])), [inventoryItems]);

  function toggleExpand(id: string) {
    setExpanded((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const rows = useMemo(() => {
    return recipes
      .map((r) => {
        const menuItem = one(r.menu_items);
        const variant = one(r.menu_variants);
        const cost = costPerYieldUnit(r, byId);
        const price = menuPriceFor(r);
        const foodCostPct = price && cost != null && price > 0 ? Math.round((cost / price) * 1000) / 10 : null;
        // A brand-new draft has no activated (current_version_id) version
        // yet — fall back to the latest saved version so its ingredients
        // still show here instead of reading as "0 ingredients" (misleading
        // now that recipe-first drafts, unlinked from any menu item edit,
        // are the common path — see RecipeForm below).
        const currentVersion =
          r.recipe_versions.find((v) => v.id === r.current_version_id) ??
          r.recipe_versions.slice().sort((a, b) => b.version - a.version)[0];
        return { recipe: r, menuItem, variant, cost, price, foodCostPct, currentVersion };
      })
      .filter((row) => {
        if (search.trim() && !row.recipe.name.toLowerCase().includes(search.trim().toLowerCase())) return false;
        if (statusFilter && row.recipe.status !== statusFilter) return false;
        if (minFoodCost.trim()) {
          const min = parseFloat(minFoodCost);
          if (row.foodCostPct == null || row.foodCostPct < min) return false;
        }
        return true;
      });
  }, [recipes, byId, search, statusFilter, minFoodCost]);

  async function run(fn: () => PromiseLike<{ error: { message: string } | null } | { error: { message: string } | null; data: unknown }>) {
    setBusy(true);
    setError(null);
    const res = await fn();
    setBusy(false);
    if (res.error) {
      setError(res.error.message);
      return false;
    }
    router.refresh();
    return true;
  }

  async function activate(versionId: string) {
    await run(() => supabase.rpc('activate_recipe_version', { p_recipe_version_id: versionId }));
  }
  async function archive(recipeId: string) {
    if (!confirm('Archive this recipe? It will stop being used for new orders, but its history is kept.')) return;
    await run(() => supabase.rpc('archive_recipe', { p_recipe_id: recipeId }));
  }

  return (
    <div className="space-y-5">
      {error && <div className="rounded border border-danger/40 bg-danger/10 text-danger p-3 text-xs">{error}</div>}

      {canManage && (
        <Card>
          {!showCreate ? (
            <Button onClick={() => setShowCreate(true)}>+ Create Recipe</Button>
          ) : (
            <RecipeForm
              mode="create"
              menuItems={menuItems}
              inventoryItems={inventoryItems}
              subRecipes={subRecipes}
              categories={categories}
              supabase={supabase}
              canViewCost={canViewCost}
              onDone={() => {
                setShowCreate(false);
                router.refresh();
              }}
              onCancel={() => setShowCreate(false)}
            />
          )}
        </Card>
      )}

      {newVersionFor && (
        <Card>
          <h2 className="font-bold text-sm mb-3">New version — {newVersionFor.name}</h2>
          <RecipeForm
            mode="version"
            recipe={newVersionFor}
            menuItems={menuItems}
            inventoryItems={inventoryItems}
            subRecipes={subRecipes}
            supabase={supabase}
            canViewCost={canViewCost}
            onDone={() => {
              setNewVersionFor(null);
              router.refresh();
            }}
            onCancel={() => setNewVersionFor(null)}
          />
        </Card>
      )}

      <Card>
        <div className="flex flex-wrap gap-3 items-end">
          <Field label="Search">
            <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Recipe name…" className="w-48" />
          </Field>
          <Field label="Status">
            <Select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className="w-32">
              <option value="">All</option>
              <option value="draft">Draft</option>
              <option value="active">Active</option>
              <option value="archived">Archived</option>
            </Select>
          </Field>
          {canViewCost && (
            <Field label="Min. food cost %">
              <Input type="number" min="0" value={minFoodCost} onChange={(e) => setMinFoodCost(e.target.value)} className="w-28" />
            </Field>
          )}
        </div>
      </Card>

      {rows.length === 0 ? (
        <p className="text-muted text-xs">No recipes match.</p>
      ) : (
        <div className="space-y-2">
          {rows.map(({ recipe: r, menuItem, variant, cost, price, foodCostPct, currentVersion }) => {
            const isOpen = expanded.has(r.id);
            const label = `${r.name}${r.recipe_type === 'variant' && variant ? ` · ${variant.name}` : ''}`;
            return (
              <Card key={r.id} className="p-0 overflow-hidden">
                <button
                  onClick={() => toggleExpand(r.id)}
                  className="w-full flex items-center justify-between gap-3 p-3 text-left hover:bg-main/40"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="font-semibold text-sm truncate">{label}</span>
                      <span
                        className={`text-[10px] font-bold uppercase px-1.5 py-0.5 rounded ${
                          r.status === 'active' ? 'bg-ok/15 text-ok' : r.status === 'draft' ? 'bg-primary/15 text-primary' : 'bg-muted/20 text-muted'
                        }`}
                      >
                        {r.status}
                      </span>
                      <span className="text-[10px] text-muted">{TYPE_LABELS[r.recipe_type]}</span>
                    </div>
                    <div className="text-[11px] text-muted mt-0.5">
                      {menuItem?.name ?? 'No product linked'} · {currentVersion?.recipe_ingredients.length ?? 0} ingredient
                      {currentVersion?.recipe_ingredients.length === 1 ? '' : 's'} · v{currentVersion?.version ?? '—'} · updated {formatDate(r.created_at)}
                    </div>
                  </div>
                  <div className="text-right shrink-0">
                    {canViewCost && cost != null && <div className="font-bold text-sm">{formatCents(cost)}</div>}
                    {canViewCost && foodCostPct != null && <div className="text-[11px] text-muted">{foodCostPct}% food cost</div>}
                  </div>
                </button>

                {isOpen && (
                  <div className="border-t border-border p-4 space-y-4">
                    {r.description && <p className="text-xs text-muted">{r.description}</p>}

                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
                      {price != null && (
                        <div>
                          <div className="text-muted">Menu Price</div>
                          <div className="font-bold">{formatCents(price)}</div>
                        </div>
                      )}
                      {canViewCost && cost != null && (
                        <div>
                          <div className="text-muted">Recipe Cost</div>
                          <div className="font-bold">{formatCents(cost)}</div>
                        </div>
                      )}
                      {canViewCost && foodCostPct != null && (
                        <div>
                          <div className="text-muted">Food Cost %</div>
                          <div className="font-bold">{foodCostPct}%</div>
                        </div>
                      )}
                      {canViewCost && price != null && cost != null && (
                        <div>
                          <div className="text-muted">Contribution</div>
                          <div className="font-bold">{formatCents(price - cost)}</div>
                        </div>
                      )}
                    </div>

                    <div>
                      <h3 className="font-bold text-xs mb-1.5">
                        Ingredients {currentVersion?.yield_qty && currentVersion.yield_qty !== 1 ? `(yields ${currentVersion.yield_qty}${currentVersion.yield_unit ?? ''})` : ''}
                      </h3>
                      <div className="space-y-1">
                        {(currentVersion?.recipe_ingredients ?? [])
                          .slice()
                          .sort((a, b) => a.sort_order - b.sort_order)
                          .map((ing) => {
                            const inv = one(ing.inventory_items);
                            const sub = one(ing.recipes);
                            const lineCost = inv ? Math.round(ing.qty_base * inv.cost_cents_per_base_unit) : null;
                            return (
                              <div key={ing.id} className="flex items-center justify-between text-xs">
                                <span>
                                  {ing.qty_base}
                                  {inv?.unit ?? ''} {inv?.name ?? (sub ? `${sub.name} (sub-recipe)` : '—')}
                                </span>
                                {canViewCost && lineCost != null && <span className="text-muted font-mono">{formatCents(lineCost)}</span>}
                              </div>
                            );
                          })}
                        {(currentVersion?.recipe_ingredients ?? []).length === 0 && (
                          <p className="text-muted text-xs">No ingredients on the current version.</p>
                        )}
                      </div>
                    </div>

                    {r.instructions && (
                      <div>
                        <h3 className="font-bold text-xs mb-1.5">Instructions</h3>
                        <p className="text-xs text-muted whitespace-pre-line">{r.instructions}</p>
                      </div>
                    )}

                    <div>
                      <h3 className="font-bold text-xs mb-1.5">Version History</h3>
                      <div className="space-y-1">
                        {r.recipe_versions
                          .slice()
                          .sort((a, b) => b.version - a.version)
                          .map((v) => (
                            <div key={v.id} className="flex items-center justify-between text-xs">
                              <span>
                                Version {v.version} — {v.status}
                                {v.effective_from ? ` · from ${formatDate(v.effective_from)}` : ''}
                                {v.effective_to ? ` to ${formatDate(v.effective_to)}` : ''}
                              </span>
                              {canManage && v.status === 'draft' && (
                                <button onClick={() => activate(v.id)} disabled={busy} className="text-primary underline text-[11px]">
                                  Activate
                                </button>
                              )}
                            </div>
                          ))}
                      </div>
                    </div>

                    {canViewCost && (currentVersion?.recipe_cost_log.length ?? 0) > 0 && (
                      <div>
                        <h3 className="font-bold text-xs mb-1.5">Cost History</h3>
                        <div className="space-y-1">
                          {currentVersion!.recipe_cost_log
                            .slice()
                            .sort((a, b) => new Date(b.recorded_at).getTime() - new Date(a.recorded_at).getTime())
                            .slice(0, 8)
                            .map((c, i) => (
                              <div key={i} className="flex items-center justify-between text-xs">
                                <span className="text-muted">{formatDate(c.recorded_at)}</span>
                                <span className="font-mono">{formatCents(c.cost_cents)}</span>
                              </div>
                            ))}
                        </div>
                      </div>
                    )}

                    {canManage && r.status !== 'archived' && (
                      <div className="flex gap-2 pt-2 border-t border-border">
                        <Button variant="ghost" onClick={() => setNewVersionFor(r)}>
                          Create New Version
                        </Button>
                        <Button variant="danger" onClick={() => archive(r.id)} disabled={busy}>
                          Archive
                        </Button>
                      </div>
                    )}
                  </div>
                )}
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}

/**
 * Shared create / new-version form (spec §52: select item -> add
 * ingredients -> system calculates cost -> review -> save). One scrollable
 * form with clear sections rather than a paginated wizard — same
 * convention as this app's other management forms (Deals, Promotions) —
 * with a live cost/food-cost preview so the "system calculates" step is
 * always visible, not a separate screen.
 */
function RecipeForm({
  mode,
  recipe,
  menuItems,
  inventoryItems,
  subRecipes,
  categories,
  supabase,
  canViewCost,
  onDone,
  onCancel,
}: {
  mode: 'create' | 'version';
  recipe?: Recipe;
  menuItems: MenuItemOption[];
  inventoryItems: InventoryItemOption[];
  subRecipes: SubRecipeOption[];
  categories?: CategoryOption[];
  supabase: ReturnType<typeof usePortalSupabase>;
  canViewCost: boolean;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(recipe?.name ?? '');
  const [description, setDescription] = useState(recipe?.description ?? '');
  const [notes, setNotes] = useState(recipe?.notes ?? '');
  const [recipeType, setRecipeType] = useState<Recipe['recipe_type']>(recipe?.recipe_type ?? 'menu_item');
  // Recipe-first workflow (default): a brand-new dish is defined by
  // building its recipe, and the menu item is created FROM it — not the
  // other way around. "existing" stays available for the retrofit case
  // (adding/replacing a recipe on a product that's already on the menu).
  const [productMode, setProductMode] = useState<'new' | 'existing'>('new');
  const [newProductPrice, setNewProductPrice] = useState('');
  const [newProductCategoryId, setNewProductCategoryId] = useState('');
  const [menuItemId, setMenuItemId] = useState(recipe?.menu_item_id ?? '');
  const [variantId, setVariantId] = useState(recipe?.variant_id ?? '');
  const [instructions, setInstructions] = useState(recipe?.instructions ?? '');
  const currentVersion = recipe?.recipe_versions.find((v) => v.id === recipe.current_version_id);
  const [yieldQty, setYieldQty] = useState(String(currentVersion?.yield_qty ?? 1));
  const [yieldUnit, setYieldUnit] = useState(currentVersion?.yield_unit ?? '');
  const [ingredients, setIngredients] = useState<DraftIngredient[]>(
    currentVersion
      ? currentVersion.recipe_ingredients.map((ing) => ({
          key: ing.id,
          kind: ing.inventory_item_id ? 'inventory' : 'sub_recipe',
          refId: ing.inventory_item_id ?? ing.sub_recipe_id ?? '',
          qty_base: String(ing.qty_base),
        }))
      : [{ key: crypto.randomUUID(), kind: 'inventory', refId: '', qty_base: '' }],
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selectedMenuItem = menuItems.find((m) => m.id === menuItemId);
  const inventoryById = new Map(inventoryItems.map((i) => [i.id, i]));
  const subRecipeById = new Map(subRecipes.map((s) => [s.id, s]));

  function updateIngredient(key: string, patch: Partial<DraftIngredient>) {
    setIngredients((rows) => rows.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  }
  function addIngredient() {
    setIngredients((rows) => [...rows, { key: crypto.randomUUID(), kind: 'inventory', refId: '', qty_base: '' }]);
  }
  function removeIngredient(key: string) {
    setIngredients((rows) => rows.filter((r) => r.key !== key));
  }

  // Live cost preview (spec §11 "system calculates cost as you go") — same
  // per-line formula the server uses for a direct ingredient; a sub-recipe
  // line shows its ingredient name only here (its own nested cost isn't
  // re-resolved client-side) — the server always computes the real, fully
  // resolved cost (including sub-recipes) the moment you save.
  const previewLines = ingredients
    .filter((row) => row.refId && row.qty_base)
    .map((row) => {
      const qty = parseFloat(row.qty_base) || 0;
      if (row.kind === 'inventory') {
        const inv = inventoryById.get(row.refId);
        const cost = canViewCost && inv?.cost_cents_per_base_unit != null ? Math.round(qty * inv.cost_cents_per_base_unit) : null;
        return { label: inv ? `${qty}${inv.unit} ${inv.name}` : '—', cost };
      }
      const sub = subRecipeById.get(row.refId);
      return { label: sub ? `${qty}${one(sub.recipe_versions)?.yield_unit ?? ''} ${sub.name} (sub-recipe)` : '—', cost: null };
    });
  const previewKnownTotal = previewLines.reduce((s, l) => s + (l.cost ?? 0), 0);
  const previewComplete = previewLines.length > 0 && previewLines.every((l) => l.cost != null);

  async function save(activate: boolean) {
    setBusy(true);
    setError(null);
    const ingredientPayload = ingredients
      .filter((r) => r.refId && r.qty_base)
      .map((r) => ({
        inventory_item_id: r.kind === 'inventory' ? r.refId : null,
        sub_recipe_id: r.kind === 'sub_recipe' ? r.refId : null,
        qty_base: parseFloat(r.qty_base),
      }));
    if (!name.trim() && mode === 'create') {
      setError('Enter a recipe name.');
      setBusy(false);
      return;
    }
    if (ingredientPayload.length === 0) {
      setError('Add at least one ingredient.');
      setBusy(false);
      return;
    }
    const creatingNewProduct = recipeType === 'menu_item' && mode === 'create' && productMode === 'new';
    if (recipeType === 'variant' && mode === 'create' && !menuItemId) {
      setError('Choose the menu item this recipe is for.');
      setBusy(false);
      return;
    }
    if (recipeType === 'menu_item' && mode === 'create' && productMode === 'existing' && !menuItemId) {
      setError('Choose the existing menu item this recipe is for.');
      setBusy(false);
      return;
    }
    let newProductCents = 0;
    if (creatingNewProduct) {
      newProductCents = Math.round(parseFloat(newProductPrice) * 100);
      if (Number.isNaN(newProductCents) || newProductCents < 0) {
        setError('Enter a valid starting price for the new product.');
        setBusy(false);
        return;
      }
    }

    let versionId: string | null = null;
    if (mode === 'create') {
      // Recipe-first: the product doesn't exist yet — create it (name +
      // "Regular" variant, same shape CreateProductModal uses) BEFORE the
      // recipe, so create_recipe's menu_item_id is always a real product,
      // matching the schema's own invariant (a menu_item/variant recipe
      // must point at a product — never the reverse dependency).
      let targetMenuItemId = menuItemId;
      if (creatingNewProduct) {
        const { data: newItem, error: itemErr } = await supabase
          .from('menu_items')
          .insert({ name: name.trim(), price_cents: 0, category_id: newProductCategoryId || null, is_available: true })
          .select('id')
          .single();
        if (itemErr || !newItem) {
          setError(itemErr?.message ?? 'Could not create the menu item.');
          setBusy(false);
          return;
        }
        const { error: variantErr } = await supabase
          .from('menu_variants')
          .insert({ menu_item_id: newItem.id, name: 'Regular', price_cents: newProductCents, sort_order: 0 });
        if (variantErr) {
          setError(variantErr.message);
          setBusy(false);
          return;
        }
        targetMenuItemId = newItem.id;
      }

      const { data, error: err } = await supabase.rpc('create_recipe', {
        p_name: name.trim(),
        p_description: description.trim() || null,
        p_notes: notes.trim() || null,
        p_recipe_type: recipeType,
        p_menu_item_id: recipeType === 'menu_item' || recipeType === 'variant' ? targetMenuItemId : null,
        p_variant_id: recipeType === 'variant' ? variantId || null : null,
        p_instructions: instructions.trim() || null,
        p_yield_qty: parseFloat(yieldQty) || 1,
        p_yield_unit: yieldUnit.trim() || null,
        p_ingredients: ingredientPayload,
      });
      if (err) {
        setError(
          creatingNewProduct
            ? `The menu item "${name.trim()}" was created, but the recipe failed to save: ${err.message}. Attach a recipe to it from here or Menu Management.`
            : err.message,
        );
        setBusy(false);
        return;
      }
      const row = Array.isArray(data) ? data[0] : data;
      versionId = row?.recipe_version_id ?? null;
    } else if (recipe) {
      const { data, error: err } = await supabase.rpc('create_recipe_version', {
        p_recipe_id: recipe.id,
        p_ingredients: ingredientPayload,
        p_yield_qty: parseFloat(yieldQty) || null,
        p_yield_unit: yieldUnit.trim() || null,
      });
      if (err) {
        setError(err.message);
        setBusy(false);
        return;
      }
      const row = Array.isArray(data) ? data[0] : data;
      versionId = row?.recipe_version_id ?? null;
    }

    if (activate && versionId) {
      const { error: actErr } = await supabase.rpc('activate_recipe_version', { p_recipe_version_id: versionId });
      if (actErr) {
        setError(`Saved as draft, but activation failed: ${actErr.message}`);
        setBusy(false);
        return;
      }
    }
    setBusy(false);
    onDone();
  }

  return (
    <div className="space-y-4">
      {error && <div className="rounded border border-danger/40 bg-danger/10 text-danger p-2.5 text-xs">{error}</div>}

      {mode === 'create' && (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Field label="Recipe Name">
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Chicken Burger Regular" />
            </Field>
            <Field label="Type">
              <Select value={recipeType} onChange={(e) => setRecipeType(e.target.value as Recipe['recipe_type'])}>
                <option value="menu_item">Menu Item</option>
                <option value="variant">Variant</option>
                <option value="semi_finished">Semi-Finished</option>
                <option value="preparation">Preparation</option>
              </Select>
            </Field>
          </div>
          <Field label="Description (optional)">
            <Input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Standard production recipe…" />
          </Field>

          {recipeType === 'menu_item' && (
            <div className="space-y-3">
              <div className="flex gap-4 text-xs">
                <label className="flex items-center gap-1.5">
                  <input type="radio" checked={productMode === 'new'} onChange={() => setProductMode('new')} />
                  Create a new menu item for this recipe
                </label>
                <label className="flex items-center gap-1.5">
                  <input type="radio" checked={productMode === 'existing'} onChange={() => setProductMode('existing')} />
                  Attach to an existing menu item
                </label>
              </div>

              {productMode === 'new' ? (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <Field label="Starting Price">
                    <Input
                      type="number"
                      step="0.01"
                      min="0"
                      value={newProductPrice}
                      onChange={(e) => setNewProductPrice(e.target.value)}
                      placeholder="0.00"
                    />
                  </Field>
                  <Field label="Category (optional)">
                    <Select value={newProductCategoryId} onChange={(e) => setNewProductCategoryId(e.target.value)}>
                      <option value="">— none —</option>
                      {(categories ?? []).map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <p className="text-[11px] text-muted sm:col-span-2">
                    Saving creates &ldquo;{name.trim() || 'this recipe’s name'}&rdquo; as a new product with a
                    Regular variant at this price, linked to this recipe. Add an image, description, extra sizes
                    and modifiers afterward in Menu Management.
                  </p>
                </div>
              ) : (
                <Field label="Menu Item">
                  <Select value={menuItemId} onChange={(e) => setMenuItemId(e.target.value)}>
                    <option value="">Choose item…</option>
                    {menuItems.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.name}
                      </option>
                    ))}
                  </Select>
                </Field>
              )}
            </div>
          )}

          {recipeType === 'variant' && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <Field label="Menu Item">
                <Select
                  value={menuItemId}
                  onChange={(e) => {
                    setMenuItemId(e.target.value);
                    setVariantId('');
                  }}
                >
                  <option value="">Choose item…</option>
                  {menuItems.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Variant">
                <Select value={variantId} onChange={(e) => setVariantId(e.target.value)}>
                  <option value="">Choose variant…</option>
                  {(selectedMenuItem?.menu_variants ?? []).map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.name}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
          )}

          {(recipeType === 'semi_finished' || recipeType === 'preparation') && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <Field label="Yield quantity">
                <Input type="number" min="0.001" step="0.001" value={yieldQty} onChange={(e) => setYieldQty(e.target.value)} />
              </Field>
              <Field label="Yield unit (e.g. g, ml, portions)">
                <Input value={yieldUnit} onChange={(e) => setYieldUnit(e.target.value)} placeholder="g" />
              </Field>
            </div>
          )}
        </>
      )}

      <div>
        <div className="flex items-baseline justify-between mb-2">
          <h3 className="font-bold text-xs">Ingredients</h3>
          <span className="text-[11px] text-muted">Quantities are in each ingredient&apos;s own stock unit</span>
        </div>
        <div className="space-y-2">
          {ingredients.map((row) => {
            const inv = row.kind === 'inventory' ? inventoryById.get(row.refId) : undefined;
            return (
              <div key={row.key} className="flex flex-wrap gap-2 items-end">
                <Select
                  value={row.kind}
                  onChange={(e) => updateIngredient(row.key, { kind: e.target.value as DraftIngredient['kind'], refId: '' })}
                  className="w-32 text-xs"
                >
                  <option value="inventory">Ingredient</option>
                  {subRecipes.length > 0 && <option value="sub_recipe">Sub-recipe</option>}
                </Select>
                <Select value={row.refId} onChange={(e) => updateIngredient(row.key, { refId: e.target.value })} className="w-48 text-xs">
                  <option value="">Choose…</option>
                  {(row.kind === 'inventory' ? inventoryItems : subRecipes).map((opt) => (
                    <option key={opt.id} value={opt.id}>
                      {opt.name}
                    </option>
                  ))}
                </Select>
                <Input
                  type="number"
                  min="0.001"
                  step="0.001"
                  value={row.qty_base}
                  onChange={(e) => updateIngredient(row.key, { qty_base: e.target.value })}
                  placeholder="Qty"
                  className="w-24 text-xs"
                />
                <span className="text-[11px] text-muted w-10">{inv?.unit ?? ''}</span>
                <button onClick={() => removeIngredient(row.key)} className="text-danger text-[11px] underline">
                  remove
                </button>
              </div>
            );
          })}
        </div>
        <Button variant="ghost" className="mt-2" onClick={addIngredient}>
          + Add Ingredient
        </Button>
      </div>

      {previewLines.length > 0 && (
        <div className="rounded border border-border p-3 text-xs space-y-1">
          <div className="font-bold mb-1">Recipe Cost Preview</div>
          {previewLines.map((l, i) => (
            <div key={i} className="flex items-center justify-between text-muted">
              <span>{l.label}</span>
              {l.cost != null && <span className="font-mono">{formatCents(l.cost)}</span>}
            </div>
          ))}
          {canViewCost && (
            <div className="flex items-center justify-between font-bold pt-1 border-t border-border">
              <span>{previewComplete ? 'Estimated Recipe Cost' : 'Estimated (partial — a sub-recipe cost isn\'t shown here)'}</span>
              <span>{formatCents(previewKnownTotal)}</span>
            </div>
          )}
          <p className="text-muted">Recomputed from live inventory cost on save — this is a preview.</p>
        </div>
      )}

      <Field label="Instructions (optional)">
        <textarea
          value={instructions}
          onChange={(e) => setInstructions(e.target.value)}
          rows={4}
          className="w-full rounded border border-border bg-surface px-3 py-2 text-xs outline-none focus:border-primary resize-none"
          placeholder={'1. Prepare chicken fillet.\n2. Fry until fully cooked.\n...'}
        />
      </Field>

      <Field label="Notes (optional, internal)">
        <Input value={notes} onChange={(e) => setNotes(e.target.value)} />
      </Field>

      <div className="flex gap-2 pt-2 border-t border-border">
        <Button onClick={() => save(false)} disabled={busy}>
          Save as Draft
        </Button>
        <Button variant="ghost" onClick={() => save(true)} disabled={busy}>
          Save &amp; Activate
        </Button>
        <Button variant="danger" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
