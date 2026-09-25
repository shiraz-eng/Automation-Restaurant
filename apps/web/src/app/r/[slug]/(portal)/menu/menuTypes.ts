/**
 * Menu Management data model + pure helpers — the exact same shapes
 * MenuManager.tsx used inline before, split out so the new presentational
 * components (ProductTable, ProductEditor, panels…) can share them without
 * a circular import back into the orchestrator.
 */

export type Category = { id: string; name: string; sort_order?: number };

export type Variant = {
  id: string;
  name: string;
  price_cents: number;
  sku: string | null;
  sort_order: number;
  is_available: boolean;
  track_availability: boolean;
  available_qty: number;
};

export type ModifierKind = 'required_single' | 'optional_single' | 'multi';
export type ModifierOption = {
  id: string;
  name: string;
  price_cents: number;
  is_available: boolean;
  sort_order: number;
};
export type ModifierGroup = {
  id: string;
  name: string;
  kind: ModifierKind;
  min_select: number;
  max_select: number | null;
  sort_order: number;
  modifier_options: ModifierOption[];
};
export const KIND_LABEL: Record<ModifierKind, string> = {
  required_single: 'Required · pick 1',
  optional_single: 'Optional · pick 1',
  multi: 'Optional · pick several',
};

export type RecipeComponentRow = {
  id: string;
  inventory_item_id: string;
  qty_per_unit: number;
  variant_id: string | null;
  inventory_items: { name: string; unit: string } | { name: string; unit: string }[] | null;
};

export type Item = {
  id: string;
  name: string;
  description: string | null;
  price_cents: number;
  is_available: boolean;
  category_id: string | null;
  image_url: string | null;
  station: string | null;
  menu_variants: Variant[];
  modifier_groups: ModifierGroup[];
  recipe_components: RecipeComponentRow[];
};

export type Ingredient = {
  id: string;
  name: string;
  unit: string;
  stock_qty: number;
  min_threshold: number;
};

// ── Recipes & Food Cost (lightweight read-only mirror — schema.sql's
// recipes/recipe_versions/recipe_ingredients is the authoritative system,
// owned by the Recipes & Food Cost page; this only summarizes it for an
// at-a-glance read here, ignoring sub-recipe nesting for simplicity. The
// full calculation (incl. sub-recipes) lives on /recipes.) ─────────────
export type RecipeIngredientRow = {
  qty_base: number;
  inventory_item_id: string | null;
  sub_recipe_id: string | null;
  inventory_items: { cost_cents_per_base_unit: number } | { cost_cents_per_base_unit: number }[] | null;
};
export type RecipeVersionRow = {
  yield_unit?: string | null;
  id: string;
  yield_qty: number;
  recipe_ingredients: RecipeIngredientRow[];
};
export type RecipeRow = {
  recipe_type?: 'menu_item' | 'variant' | 'semi_finished' | 'preparation';
  id: string;
  name: string;
  status: 'draft' | 'active' | 'archived';
  menu_item_id: string | null;
  variant_id: string | null;
  current_version_id: string | null;
  recipe_versions: RecipeVersionRow[];
  /** Every dish / size this recipe is linked to (migration 0070). One
   *  recipe can be shared; each dish/size has at most one recipe. */
  recipe_links?: RecipeLinkRow[];
};
export type RecipeLinkRow = { menu_item_id: string; variant_id: string | null };

/** The recipe linked to exactly this dish (variantId null) or size. */
export function recipeLinkedTo(recipes: RecipeRow[], itemId: string, variantId: string | null): RecipeRow | null {
  return recipes.find((r) => (r.recipe_links ?? []).some((l) => l.menu_item_id === itemId && l.variant_id === variantId)) ?? null;
}

/** Every (recipe, size) link on this dish — the whole-dish link has variant_id null. */
export function linksForItem(recipes: RecipeRow[], itemId: string): { recipe: RecipeRow; variant_id: string | null }[] {
  const out: { recipe: RecipeRow; variant_id: string | null }[] = [];
  for (const r of recipes) for (const l of r.recipe_links ?? []) if (l.menu_item_id === itemId) out.push({ recipe: r, variant_id: l.variant_id });
  return out;
}

// ── Deals (same shape deals/page.tsx already queries — used here only to
// read which deals this item participates in; Deals stays authoritative
// for pricing/editing.) ─────────────────────────────────────────────────
export type DealComponentRow = { menu_item_id: string | null; variant_id: string | null; qty: number };
export type DealOptionItemRow = { menu_item_id: string | null; variant_id: string | null };
export type DealOptionGroupRow = { deal_option_items: DealOptionItemRow[] };
export type DealRow = {
  id: string;
  name: string;
  price_cents: number;
  is_available: boolean;
  deal_components: DealComponentRow[];
  deal_option_groups: DealOptionGroupRow[];
};

function one<T>(x: T | T[] | null): T | null {
  return Array.isArray(x) ? (x[0] ?? null) : x;
}

export function ingredientRef(x: RecipeComponentRow['inventory_items']): { name: string; unit: string } | null {
  return one(x);
}

/** Mirrors RecipesManager.tsx's computeCost()/costPerYieldUnit() for
 *  direct (non-sub-recipe) ingredients only — a provisional at-a-glance
 *  figure; /recipes remains the authoritative, complete calculation. */
export function recipeFoodCost(
  recipe: RecipeRow,
  priceForCost: number | null,
): { costCents: number; foodCostPct: number | null } | null {
  if (!recipe.current_version_id) return null;
  const version = recipe.recipe_versions.find((v) => v.id === recipe.current_version_id);
  if (!version) return null;
  let total = 0;
  for (const ing of version.recipe_ingredients) {
    if (!ing.inventory_item_id) continue; // sub-recipe ingredients: see /recipes for the full figure
    const inv = one(ing.inventory_items);
    total += Math.round(ing.qty_base * (inv?.cost_cents_per_base_unit ?? 0));
  }
  const costCents = Math.round(total / Math.max(version.yield_qty, 0.0001));
  const foodCostPct = priceForCost && priceForCost > 0 ? Math.round((costCents / priceForCost) * 1000) / 10 : null;
  return { costCents, foodCostPct };
}

/** The recipe linked to this item — its own variant-specific recipe takes
 *  priority over a base item-level one, same convention the Recipes page
 *  itself uses when resolving which recipe prices which line. */
export function recipeForItem(recipes: RecipeRow[], itemId: string, variantId?: string): RecipeRow | null {
  if (variantId) {
    const forVariant = recipeLinkedTo(recipes, itemId, variantId);
    if (forVariant) return forVariant;
  }
  return recipeLinkedTo(recipes, itemId, null);
}

export type DealMembership = { deal: DealRow; qty: number };

/** Every active deal that includes this item, as a fixed component or a
 *  Build-Your-Own option — read-only membership, not a second pricing
 *  path (Deals stays authoritative for price/savings). */
export function dealsForItem(deals: DealRow[], itemId: string): DealMembership[] {
  const out: DealMembership[] = [];
  for (const d of deals) {
    const comp = d.deal_components.find((c) => c.menu_item_id === itemId);
    if (comp) {
      out.push({ deal: d, qty: comp.qty });
      continue;
    }
    const inOption = d.deal_option_groups.some((g) => g.deal_option_items.some((oi) => oi.menu_item_id === itemId));
    if (inOption) out.push({ deal: d, qty: 1 });
  }
  return out;
}

export type AvailabilityStatus = 'available' | 'unavailable' | 'sold_out' | 'low_stock' | 'out_of_stock';

// ── Recipe-driven availability engine (product_availability /
// availability_audit_log, tenant-migrations/0052) — a derived "can we
// actually make this right now" signal computed server-side from live
// inventory, layered ON TOP of the manual toggles above rather than
// replacing them. One row per (menu_item_id, variant_id) that has a
// recipe; absence of any row for an item means the engine doesn't track
// it (no recipe configured), so manual toggles remain the only signal. ──
export type ComputedAvailabilityStatus = 'available' | 'low_stock' | 'unavailable';
export type ProductAvailabilityRow = {
  menu_item_id: string;
  variant_id: string | null;
  status: ComputedAvailabilityStatus;
  producible_qty: number | null;
  bottleneck_inventory_item_id: string | null;
  reason: string | null;
};

export function computedRowsForItem(rows: ProductAvailabilityRow[], itemId: string): ProductAvailabilityRow[] {
  return rows.filter((r) => r.menu_item_id === itemId);
}

/** The worst-case computed signal across every tracked row for this item —
 *  null when the engine isn't tracking it at all (no recipe). Fully
 *  unavailable only when EVERY tracked (item, variant) row is at 0; if just
 *  one variant among several is out, the item as a whole is still sellable
 *  so this reads as low_stock with that variant's real reason attached. */
export function computedStatusForItem(
  rows: ProductAvailabilityRow[],
  itemId: string,
): { status: ComputedAvailabilityStatus; reason: string | null; producibleQty: number | null } | null {
  const forItem = computedRowsForItem(rows, itemId);
  if (forItem.length === 0) return null;
  if (forItem.every((r) => r.status === 'unavailable')) {
    return { status: 'unavailable', reason: forItem[0].reason, producibleQty: 0 };
  }
  const issue = forItem.find((r) => r.status !== 'available');
  if (issue) return { status: 'low_stock', reason: issue.reason, producibleQty: issue.producible_qty };
  const total = forItem.reduce((s, r) => s + (r.producible_qty ?? 0), 0);
  return { status: 'available', reason: null, producibleQty: total };
}

/** One item-level status for the table/editor. Priority (worst first):
 *  manually hidden > manually sold out > computed-unavailable (engine says
 *  0 producible even though it's toggled on) > computed-low-stock >
 *  available. Manual toggles always take precedence — an Owner hiding a
 *  product on purpose isn't second-guessed by the inventory engine. */
export function itemAvailabilityStatus(item: Item, availabilityRows?: ProductAvailabilityRow[]): AvailabilityStatus {
  if (!item.is_available) return 'unavailable';
  const variants = item.menu_variants;
  if (variants.length > 0 && variants.every((v) => v.track_availability && v.available_qty <= 0)) {
    return 'sold_out';
  }
  if (availabilityRows) {
    const computed = computedStatusForItem(availabilityRows, item.id);
    if (computed?.status === 'unavailable') return 'out_of_stock';
    if (computed?.status === 'low_stock') return 'low_stock';
  }
  return 'available';
}

export const STATUS_LABEL: Record<AvailabilityStatus, string> = {
  available: 'Available',
  unavailable: 'Hidden',
  sold_out: 'Sold Out',
  low_stock: 'Low Stock',
  out_of_stock: 'Out of Stock',
};

/** Min variant price — same "from $X" convention the storefront/Recipes
 *  page use for a multi-variant item. */
export function minPriceCents(item: Item): number {
  return item.menu_variants.reduce((m, v) => Math.min(m, v.price_cents), item.menu_variants[0]?.price_cents ?? 0);
}

export function modifierOptionCount(item: Item): number {
  return item.modifier_groups.reduce((s, g) => s + g.modifier_options.length, 0);
}
