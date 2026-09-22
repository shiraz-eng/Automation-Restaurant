/**
 * Menu/cart/deal data model + pure helpers — the exact same shapes and
 * logic that used to live inline in StorefrontClient.tsx, unchanged, just
 * split out so the new presentational components (ProductCard, DealCard,
 * ItemSheet, DealSheet, CartContents…) can import the types without a
 * circular import back into the orchestrator component.
 */

export type MenuCategory = { id: string; name: string; sort_order: number };
// computed_available comes from the recipe-driven availability engine
// (tenant-migrations/0052) — a plain boolean only, no bottleneck/reason
// (spec §26). Absent/true = orderable; false = shown but not orderable.
export type Variant = { id: string; name: string; price_cents: number; sort_order: number; computed_available?: boolean };
export type ModifierKind = 'required_single' | 'optional_single' | 'multi';
export type ModOption = { id: string; name: string; price_cents: number; sort_order: number };
export type ModGroup = {
  id: string;
  name: string;
  kind: ModifierKind;
  min_select: number;
  max_select: number | null;
  sort_order: number;
  modifier_options: ModOption[];
};
export type MenuItem = {
  id: string;
  name: string;
  description?: string | null;
  price_cents: number;
  category_id: string | null;
  image_url?: string | null;
  menu_variants: Variant[];
  modifier_groups?: ModGroup[];
  computed_available?: boolean;
};
/** A selectable product = one variant, labelled with its item. Carries its
 *  parent item's modifier groups. Cart lines and deal-matching are keyed at
 *  this level — one variant, fully resolved — regardless of how it was
 *  chosen (instant add, or via the item sheet's variant picker). */
export type Product = {
  id: string;
  item_id: string;
  name: string;
  price_cents: number;
  category_id: string | null;
  image_url: string | null;
  modifier_groups: ModGroup[];
};

/** What the customer actually browses: one card per menu item, not one per
 *  variant — "Chicken Burger" is a single card; Regular vs Large is a
 *  choice made inside its detail sheet, exactly like a modifier group, not
 *  a second card that looks like a different product. */
export type BrowseItem = {
  id: string;
  name: string;
  description: string | null;
  minPriceCents: number;
  category_id: string | null;
  image_url: string | null;
  variants: Variant[];
  modifier_groups: ModGroup[];
  /** false only when the availability engine says every variant is
   *  currently unmakeable — the item still shows (spec §26), just flagged. */
  computed_available: boolean;
};

export type NamedRef = { name: string } | { name: string }[] | null;
export type PricedRef = ({ name: string; price_cents: number } | { name: string; price_cents: number }[]) | null;
// A deal component pinned to a specific menu item (no variant_id) prices
// from that item's own default (lowest sort_order) variant — menu_items
// .price_cents is an unused fallback, never the real price (place_order
// itself resolves item-only components the same way; see schema.sql).
export type PricedItemRef =
  | ({ name: string; price_cents: number; menu_variants: { price_cents: number; sort_order: number }[] } | { name: string; price_cents: number; menu_variants: { price_cents: number; sort_order: number }[] }[])
  | null;
/** One selectable choice inside a Build-Your-Own option group. Carries only
 *  a name for display — the server re-prices and re-validates every
 *  selection on submit, exactly like modifier options. */
export type DealOptionItem = {
  id: string;
  menu_item_id: string | null;
  variant_id: string | null;
  qty: number;
  price_adjustment_cents: number;
  is_default: boolean;
  sort_order: number;
  menu_items: NamedRef;
  menu_variants: NamedRef;
};
export type DealOptionGroup = {
  id: string;
  name: string;
  min_select: number;
  max_select: number | null;
  sort_order: number;
  deal_option_items: DealOptionItem[];
};
export type DealLite = {
  id: string;
  name: string;
  description?: string | null;
  image_url?: string | null;
  price_cents: number;
  deal_components: {
    qty: number;
    menu_item_id: string | null;
    variant_id: string | null;
    menu_items: PricedItemRef;
    menu_variants: PricedRef;
  }[];
  deal_option_groups?: DealOptionGroup[];
};

export function one<T>(x: T | T[] | null): T | null {
  if (!x) return null;
  return Array.isArray(x) ? (x[0] ?? null) : x;
}
export function refName(x: NamedRef): string {
  return one(x)?.name ?? '';
}

export const TAX_RATE_BPS = 800;

export function toProducts(items: MenuItem[]): Product[] {
  const out: Product[] = [];
  for (const it of items) {
    for (const v of (it.menu_variants ?? []).slice().sort((a, b) => a.sort_order - b.sort_order)) {
      out.push({
        id: v.id,
        item_id: it.id,
        name: v.name === 'Regular' ? it.name : `${it.name} · ${v.name}`,
        price_cents: v.price_cents,
        category_id: it.category_id,
        image_url: it.image_url ?? null,
        modifier_groups: it.modifier_groups ?? [],
      });
    }
  }
  return out;
}

export function toBrowseItems(items: MenuItem[]): BrowseItem[] {
  return items
    .map((it) => {
      const variants = (it.menu_variants ?? []).slice().sort((a, b) => a.sort_order - b.sort_order);
      return {
        id: it.id,
        name: it.name,
        description: it.description ?? null,
        minPriceCents: variants.reduce((m, v) => Math.min(m, v.price_cents), variants[0]?.price_cents ?? 0),
        category_id: it.category_id,
        image_url: it.image_url ?? null,
        variants,
        modifier_groups: it.modifier_groups ?? [],
        computed_available: it.computed_available !== false,
      };
    })
    .filter((it) => it.variants.length > 0);
}

/** A cart line's identity: the same variant with a different modifier
 *  selection is a genuinely different line — but "no modifiers selected"
 *  keeps the plain variant-id key, so items without modifiers, and deal
 *  recognition (which only ever touches plain variant-id entries), behave
 *  exactly as before. */
export function cartKey(variantId: string, modifierIds: string[]): string {
  return modifierIds.length ? `${variantId}::${[...modifierIds].sort().join(',')}` : variantId;
}

export type CartLine = {
  item: Product;
  qty: number;
  modifierIds: string[];
  modifierSnapshot: ModOption[]; // resolved at add-time, for display only — server re-resolves on submit
};

/** A deal with a different Build-Your-Own selection is a different cart
 *  line, same identity rule as CartLine's modifiers. A deal with no option
 *  groups keeps the plain deal-id key, so existing simple combos behave
 *  exactly as before. */
export type DealCartLine = {
  deal: DealLite;
  qty: number;
  optionIds: string[];
  optionsSnapshot: DealOptionItem[]; // resolved at add-time, for display/price only — server re-resolves on submit
};
export function dealLineUnitPrice(d: DealCartLine): number {
  return d.deal.price_cents + d.optionsSnapshot.reduce((s, o) => s + o.price_adjustment_cents * o.qty, 0);
}
export function dealOptionLabel(o: DealOptionItem): string {
  return refName(o.menu_variants) || refName(o.menu_items) || 'option';
}

/** Static "buy separately" total for a deal's fixed components, using only
 *  the live prices the menu query already returned — independent of the
 *  current cart, so a deal card can show its savings before anything's been
 *  added. Same per-component pricing rule findDealMatches() uses (a pinned
 *  variant's own price, or an item-only component's lowest-sort variant). */
export function dealIndividualTotalCents(deal: DealLite): number {
  let total = 0;
  for (const c of deal.deal_components) {
    const compVariant = one(c.menu_variants);
    const compItem = one(c.menu_items);
    const defaultVariant = compItem?.menu_variants
      ? [...compItem.menu_variants].sort((a, b) => a.sort_order - b.sort_order)[0]
      : undefined;
    const unitPrice = compVariant?.price_cents ?? defaultVariant?.price_cents ?? 0;
    total += unitPrice * c.qty;
  }
  return total;
}

/**
 * Smart cart / deal recognition. Deterministic — NOT an LLM call — because
 * savings shown to a paying customer must always come straight from
 * authoritative current prices, never a model's guess.
 *
 * For each deal, checks whether the current cart already contains enough of
 * each component (by exact variant, or any variant of the component's item
 * when the deal doesn't pin one). A full match is switchable in one tap; a
 * match missing exactly one component becomes a soft "you're close" nudge.
 * Only plain (no-modifier) cart lines are matched against deals — a
 * customized item isn't silently folded into a combo.
 */
export type DealMatch = {
  deal: DealLite;
  kind: 'match' | 'almost';
  individualTotalCents: number;
  savingsCents: number;
  usedProductIds: Record<string, number>; // product id -> qty this deal consumes on switch
  missing?: { label: string; variantId: string | null };
};

export function findDealMatches(
  deals: DealLite[],
  cart: Record<string, CartLine>,
  products: Product[],
): DealMatch[] {
  const productsById = new Map(products.map((p) => [p.id, p]));
  const out: DealMatch[] = [];

  for (const deal of deals) {
    // Plain (no-modifier) lines only — pool sums by variant id in case the
    // same variant appears with and without customization in the cart.
    const pool = new Map<string, number>();
    for (const l of Object.values(cart)) {
      if (l.modifierIds.length > 0) continue;
      pool.set(l.item.id, (pool.get(l.item.id) ?? 0) + l.qty);
    }
    const used: Record<string, number> = {};
    let individualTotal = 0;
    let unmetComponents = 0;
    let lastMissing: { label: string; variantId: string | null } | null = null;

    for (const c of deal.deal_components) {
      const compVariant = one(c.menu_variants);
      const compItem = one(c.menu_items);
      const label = compVariant?.name || compItem?.name || 'item';
      const defaultVariant = compItem?.menu_variants
        ? [...compItem.menu_variants].sort((a, b) => a.sort_order - b.sort_order)[0]
        : undefined;
      const unitPrice = compVariant?.price_cents ?? defaultVariant?.price_cents ?? 0;
      individualTotal += unitPrice * c.qty;

      let have = 0;
      if (c.variant_id) {
        have = Math.min(pool.get(c.variant_id) ?? 0, c.qty);
        if (have > 0) used[c.variant_id] = (used[c.variant_id] ?? 0) + have;
      } else if (c.menu_item_id) {
        // Any variant of this item satisfies the component.
        let remaining = c.qty;
        for (const [pid, qty] of pool) {
          if (remaining <= 0) break;
          if (productsById.get(pid)?.item_id !== c.menu_item_id || qty <= 0) continue;
          const take = Math.min(qty, remaining);
          pool.set(pid, qty - take);
          used[pid] = (used[pid] ?? 0) + take;
          remaining -= take;
        }
        have = c.qty - remaining;
      }
      if (c.variant_id) pool.set(c.variant_id, (pool.get(c.variant_id) ?? 0) - have);

      if (have < c.qty) {
        unmetComponents += 1;
        lastMissing = { label, variantId: c.variant_id };
      }
    }

    const savings = individualTotal - deal.price_cents;
    if (savings <= 0) continue; // never suggest a "deal" that isn't cheaper
    if (unmetComponents === 0) {
      out.push({ deal, kind: 'match', individualTotalCents: individualTotal, savingsCents: savings, usedProductIds: used });
    } else if (unmetComponents === 1 && lastMissing) {
      out.push({
        deal,
        kind: 'almost',
        individualTotalCents: individualTotal,
        savingsCents: savings,
        usedProductIds: used,
        missing: lastMissing,
      });
    }
  }
  return out;
}

/** place_order() (schema.sql) raises a small set of named, colon-prefixed
 *  business errors (e.g. "insufficient_stock: <uuid>") — everything else is
 *  an unexpected/internal failure. Maps the known ones to plain language a
 *  paying customer can act on, and never lets a raw Postgres/constraint
 *  message reach the checkout screen. */
const ORDER_ERROR_MESSAGES: Record<string, string> = {
  no_lines: 'Your cart is empty.',
  bad_qty: "One of the quantities in your cart isn't valid.",
  deal_not_found: 'That deal is no longer available — please remove it and try again.',
  deal_unavailable: 'That deal just sold out — please remove it and try again.',
  deal_item_unavailable: 'Part of that deal just sold out — please remove it and try again.',
  deal_option_required: 'Please finish choosing your combo options.',
  deal_option_too_many: 'Too many options selected for one of your combos — please review it.',
  variant_not_found: 'One of the items in your cart is no longer on the menu.',
  menu_item_not_found: 'One of the items in your cart is no longer on the menu.',
  item_unavailable: 'One of the items in your cart just sold out — please adjust your order.',
  insufficient_stock: 'One of the items in your cart just sold out — please adjust your order.',
  modifier_required: 'Please finish choosing the required options for one of your items.',
  modifier_too_many: 'Too many options selected for one of your items — please review it.',
};
export function friendlyOrderError(message: string | null | undefined): string {
  const code = (message ?? '').split(':')[0].trim();
  return ORDER_ERROR_MESSAGES[code] ?? "We couldn't place your order — please try again in a moment.";
}

/** Real, non-fabricated "You may also like" — other items in the same
 *  category. Real "Make it a meal" — deals that actually contain this item
 *  as a fixed component or a Build-Your-Own option (spec §10: use actual
 *  restaurant products/existing business logic, never invented combos). */
export function relatedItems(all: BrowseItem[], current: BrowseItem, limit = 6): BrowseItem[] {
  return all.filter((i) => i.id !== current.id && i.category_id === current.category_id).slice(0, limit);
}
export function dealsContainingItem(deals: DealLite[], itemId: string): DealLite[] {
  return deals.filter(
    (d) =>
      d.deal_components.some((c) => c.menu_item_id === itemId) ||
      (d.deal_option_groups ?? []).some((g) => g.deal_option_items.some((oi) => oi.menu_item_id === itemId)),
  );
}
