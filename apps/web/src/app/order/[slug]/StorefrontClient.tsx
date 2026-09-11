'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { formatCents } from '@/lib/format';

export type MenuCategory = { id: string; name: string; sort_order: number };
type Variant = { id: string; name: string; price_cents: number; sort_order: number };
type ModifierKind = 'required_single' | 'optional_single' | 'multi';
type ModOption = { id: string; name: string; price_cents: number; sort_order: number };
type ModGroup = {
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
};
/** A selectable product = one variant, labelled with its item. Carries its
 *  parent item's modifier groups. Cart lines and deal-matching are keyed at
 *  this level — one variant, fully resolved — regardless of how it was
 *  chosen (instant add, or via the item sheet's variant picker). */
type Product = {
  id: string;
  item_id: string;
  name: string;
  price_cents: number;
  category_id: string | null;
  image_url: string | null;
  modifier_groups: ModGroup[];
};

/** What the customer actually browses: one card per menu item, not one per
 *  variant (spec §5-6, §9-11) — "Chicken Burger" is a single card; Regular
 *  vs Large is a choice made inside its detail sheet, exactly like a
 *  modifier group, not a second card that looks like a different product. */
type BrowseItem = {
  id: string;
  name: string;
  minPriceCents: number;
  category_id: string | null;
  image_url: string | null;
  variants: Variant[];
  modifier_groups: ModGroup[];
};

type NamedRef = { name: string } | { name: string }[] | null;
type PricedRef = ({ name: string; price_cents: number } | { name: string; price_cents: number }[]) | null;
/** One selectable choice inside a Build-Your-Own option group (spec §7-10).
 *  Carries only a name for display — the server re-prices and re-validates
 *  every selection on submit, exactly like modifier options. */
type DealOptionItem = {
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
type DealOptionGroup = {
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
    menu_items: PricedRef;
    menu_variants: PricedRef;
  }[];
  deal_option_groups?: DealOptionGroup[];
};
function one<T>(x: T | T[] | null): T | null {
  if (!x) return null;
  return Array.isArray(x) ? (x[0] ?? null) : x;
}
function refName(x: NamedRef): string {
  return one(x)?.name ?? '';
}

const TAX_RATE_BPS = 800;

function toProducts(items: MenuItem[]): Product[] {
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

function toBrowseItems(items: MenuItem[]): BrowseItem[] {
  return items
    .map((it) => {
      const variants = (it.menu_variants ?? []).slice().sort((a, b) => a.sort_order - b.sort_order);
      return {
        id: it.id,
        name: it.name,
        minPriceCents: variants.reduce((m, v) => Math.min(m, v.price_cents), variants[0]?.price_cents ?? 0),
        category_id: it.category_id,
        image_url: it.image_url ?? null,
        variants,
        modifier_groups: it.modifier_groups ?? [],
      };
    })
    .filter((it) => it.variants.length > 0);
}

/** A cart line's identity: the same variant with a different modifier
 *  selection is a genuinely different line (spec §15) — but "no modifiers
 *  selected" keeps the plain variant-id key, so items without modifiers, and
 *  deal recognition (which only ever touches plain variant-id entries),
 *  behave exactly as before. */
function cartKey(variantId: string, modifierIds: string[]): string {
  return modifierIds.length ? `${variantId}::${[...modifierIds].sort().join(',')}` : variantId;
}

type CartLine = {
  item: Product;
  qty: number;
  modifierIds: string[];
  modifierSnapshot: ModOption[]; // resolved at add-time, for display only — server re-resolves on submit
};

/** A deal with a different Build-Your-Own selection is a different cart
 *  line, same identity rule as CartLine's modifiers (spec §15). A deal with
 *  no option groups keeps the plain deal-id key, so existing simple combos
 *  behave exactly as before. */
type DealCartLine = {
  deal: DealLite;
  qty: number;
  optionIds: string[];
  optionsSnapshot: DealOptionItem[]; // resolved at add-time, for display/price only — server re-resolves on submit
};
function dealLineUnitPrice(d: DealCartLine): number {
  return d.deal.price_cents + d.optionsSnapshot.reduce((s, o) => s + o.price_adjustment_cents * o.qty, 0);
}
function dealOptionLabel(o: DealOptionItem): string {
  return refName(o.menu_variants) || refName(o.menu_items) || 'option';
}

/**
 * Smart cart / deal recognition (AI spec §14-16, §63, §89). Deterministic —
 * NOT an LLM call — because savings shown to a paying customer must always
 * come straight from authoritative current prices, never a model's guess.
 *
 * For each deal, checks whether the current cart already contains enough of
 * each component (by exact variant, or any variant of the component's item
 * when the deal doesn't pin one). A full match is switchable in one tap; a
 * match missing exactly one component becomes a soft "you're close" nudge.
 * Only plain (no-modifier) cart lines are matched against deals — a
 * customized item isn't silently folded into a combo.
 */
type DealMatch = {
  deal: DealLite;
  kind: 'match' | 'almost';
  individualTotalCents: number;
  savingsCents: number;
  usedProductIds: Record<string, number>; // product id -> qty this deal consumes on switch
  missing?: { label: string; variantId: string | null };
};

function findDealMatches(
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
      const unitPrice = compVariant?.price_cents ?? compItem?.price_cents ?? 0;
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

export function StorefrontClient({
  slug,
  restaurantName,
  table,
  categories,
  items,
  deals,
}: {
  slug: string;
  restaurantName: string;
  table: string | null;
  categories: MenuCategory[];
  items: MenuItem[];
  deals: DealLite[];
}) {
  const router = useRouter();
  const [guestName, setGuestName] = useState('');
  const [tableLabel, setTableLabel] = useState(table ?? '');
  const [started, setStarted] = useState(false);

  const [activeCat, setActiveCat] = useState('all');
  const [cart, setCart] = useState<Record<string, CartLine>>({});
  const [dealCart, setDealCart] = useState<Record<string, DealCartLine>>({});
  const [orderNote, setOrderNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [configuring, setConfiguring] = useState<BrowseItem | null>(null);
  const [configuringDeal, setConfiguringDeal] = useState<DealLite | null>(null);

  const [promo, setPromo] = useState('');
  const [promoState, setPromoState] = useState<
    | { status: 'idle' | 'checking' }
    | { status: 'ok'; code: string; discount: number; kind: 'percent' | 'fixed' | 'bogo' }
    | { status: 'bad' }
  >({ status: 'idle' });

  // Flat variant list — deal-matching and cart lines work at this level
  // regardless of how a variant was chosen (instant add vs. the item sheet).
  const products = useMemo(() => toProducts(items), [items]);
  // What's actually browsed: one card per item (spec §5-6).
  const browseItems = useMemo(() => toBrowseItems(items), [items]);
  const shownItems = browseItems.filter((i) => activeCat === 'all' || i.category_id === activeCat);
  const lines = Object.values(cart);
  const dealLines = Object.values(dealCart);
  const lineUnitPrice = (l: CartLine) =>
    l.item.price_cents + l.modifierSnapshot.reduce((s, m) => s + m.price_cents, 0);
  const subtotal = useMemo(
    () =>
      lines.reduce((s, l) => s + lineUnitPrice(l) * l.qty, 0) +
      dealLines.reduce((s, d) => s + dealLineUnitPrice(d) * d.qty, 0),
    [lines, dealLines],
  );
  const discount = promoState.status === 'ok' ? Math.min(promoState.discount, subtotal) : 0;
  const tax = Math.round(((subtotal - discount) * TAX_RATE_BPS) / 10000);
  const total = subtotal - discount + tax;
  const count =
    lines.reduce((s, l) => s + l.qty, 0) + dealLines.reduce((s, d) => s + d.qty, 0);

  /** Simple deal, no option groups: instant add/remove, same as before. */
  function bumpDeal(deal: DealLite, delta: number) {
    setError(null);
    setPromoState((s) => (s.status === 'ok' || s.status === 'bad' ? { status: 'idle' } : s));
    setDealCart((c) => {
      const next = { ...c };
      const qty = (next[deal.id]?.qty ?? 0) + delta;
      if (qty <= 0) delete next[deal.id];
      else next[deal.id] = { deal, qty, optionIds: [], optionsSnapshot: [] };
      return next;
    });
  }

  /** Build-Your-Own deal: add exactly the configured selection (called from the deal sheet). */
  function addConfiguredDeal(deal: DealLite, optionIds: string[], optionsSnapshot: DealOptionItem[]) {
    setError(null);
    setPromoState((s) => (s.status === 'ok' || s.status === 'bad' ? { status: 'idle' } : s));
    const key = cartKey(deal.id, optionIds);
    setDealCart((c) => ({
      ...c,
      [key]: { deal, qty: (c[key]?.qty ?? 0) + 1, optionIds, optionsSnapshot },
    }));
    setConfiguringDeal(null);
  }

  function removeDealLine(key: string) {
    setDealCart((c) => {
      const next = { ...c };
      delete next[key];
      return next;
    });
  }
  function setDealLineQty(key: string, qty: number) {
    setDealCart((c) => {
      const next = { ...c };
      if (qty <= 0) delete next[key];
      else if (next[key]) next[key] = { ...next[key], qty };
      return next;
    });
  }

  // Only offer a deal the cart hasn't already been switched to.
  const dealMatches = useMemo(
    () => findDealMatches(deals, cart, products).filter((m) => !dealCart[m.deal.id]),
    [deals, cart, products, dealCart],
  );

  /** One-tap: pull the matched (plain, unmodified) items out of the cart and add the deal instead. */
  function switchToDeal(match: DealMatch) {
    setError(null);
    setCart((c) => {
      const next = { ...c };
      for (let [pid, need] of Object.entries(match.usedProductIds)) {
        for (const [key, line] of Object.entries(next)) {
          if (need <= 0) break;
          if (line.modifierIds.length > 0 || line.item.id !== pid) continue;
          const take = Math.min(line.qty, need);
          const remaining = line.qty - take;
          if (remaining <= 0) delete next[key];
          else next[key] = { ...line, qty: remaining };
          need -= take;
        }
      }
      return next;
    });
    bumpDeal(match.deal, 1);
  }

  /** "Almost there" nudge: add the one missing variant (no modifiers) so the deal fully matches. */
  function addMissingAndSwitch(match: DealMatch) {
    if (!match.missing?.variantId) return;
    const product = products.find((p) => p.id === match.missing!.variantId);
    if (!product) return;
    const key = cartKey(product.id, []);
    setCart((c) => ({
      ...c,
      [key]: { item: product, qty: (c[key]?.qty ?? 0) + 1, modifierIds: [], modifierSnapshot: [] },
    }));
  }

  async function checkPromo() {
    const code = promo.trim();
    if (!code || subtotal === 0) return;
    setPromoState({ status: 'checking' });
    try {
      const qs = new URLSearchParams({ slug, code, subtotal: String(subtotal) }).toString();
      const res = await fetch(`/api/promo?${qs}`);
      const body = await res.json();
      setPromoState(
        body.valid
          ? { status: 'ok', code, discount: body.discount_cents ?? 0, kind: body.kind ?? 'fixed' }
          : { status: 'bad' },
      );
    } catch {
      setPromoState({ status: 'bad' });
    }
  }

  /** Simple item, no modifiers: instant add/remove, same as before. */
  function bump(item: Product, delta: number) {
    setError(null);
    setPromoState((s) => (s.status === 'ok' || s.status === 'bad' ? { status: 'idle' } : s));
    const key = cartKey(item.id, []);
    setCart((c) => {
      const next = { ...c };
      const qty = (next[key]?.qty ?? 0) + delta;
      if (qty <= 0) delete next[key];
      else next[key] = { item, qty, modifierIds: [], modifierSnapshot: [] };
      return next;
    });
  }

  /** Item with modifier groups: add exactly the configured selection (called from the config panel). */
  function addConfigured(item: Product, modifierIds: string[], modifierSnapshot: ModOption[]) {
    setError(null);
    setPromoState((s) => (s.status === 'ok' || s.status === 'bad' ? { status: 'idle' } : s));
    const key = cartKey(item.id, modifierIds);
    setCart((c) => ({
      ...c,
      [key]: { item, qty: (c[key]?.qty ?? 0) + 1, modifierIds, modifierSnapshot },
    }));
    setConfiguring(null);
  }

  function removeLine(key: string) {
    setCart((c) => {
      const next = { ...c };
      delete next[key];
      return next;
    });
  }
  function setLineQty(key: string, qty: number) {
    setCart((c) => {
      const next = { ...c };
      if (qty <= 0) delete next[key];
      else if (next[key]) next[key] = { ...next[key], qty };
      return next;
    });
  }

  async function placeOrder() {
    if (lines.length === 0 && dealLines.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/order', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          slug,
          table: tableLabel.trim() || undefined,
          guest_name: guestName.trim() || undefined,
          channel: 'dine_in',
          promo_code:
            promoState.status === 'ok' ? promoState.code : promo.trim() || undefined,
          customer_note: orderNote.trim() || undefined,
          lines: [
            ...lines.map((l) => ({
              variant_id: l.item.id,
              qty: l.qty,
              ...(l.modifierIds.length ? { modifier_option_ids: l.modifierIds } : {}),
            })),
            ...dealLines.map((d) => ({
              deal_id: d.deal.id,
              qty: d.qty,
              ...(d.optionIds.length ? { deal_option_ids: d.optionIds } : {}),
            })),
          ],
        }),
      });
      const body = await res.json();
      if (!res.ok || !body.order_id) {
        setError(body.message ?? body.error ?? 'Could not place the order.');
        return;
      }
      const q = new URLSearchParams({ table: tableLabel.trim(), guest: guestName.trim() });
      router.push(`/order/${slug}/track/${body.order_id}?${q.toString()}`);
    } catch {
      setError('Network error. Try again.');
    } finally {
      setBusy(false);
    }
  }

  if (!started) {
    return (
      <div className="min-h-screen grid place-items-center px-6">
        <div className="w-full max-w-sm">
          <h1 className="text-xl font-black">Welcome to {restaurantName}</h1>
          <p className="text-muted text-sm mb-6">Order from your table — no sign-up.</p>
          <label className="block mb-3">
            <span className="text-muted text-xs font-semibold">Your name</span>
            <input
              autoFocus
              value={guestName}
              onChange={(e) => setGuestName(e.target.value)}
              className="mt-1 w-full rounded border border-border bg-surface px-3 py-2 outline-none focus:border-primary"
            />
          </label>
          <label className="block mb-6">
            <span className="text-muted text-xs font-semibold">Table</span>
            <input
              value={tableLabel}
              onChange={(e) => setTableLabel(e.target.value)}
              className="mt-1 w-full rounded border border-border bg-surface px-3 py-2 outline-none focus:border-primary"
            />
          </label>
          <button
            onClick={() => guestName.trim() && setStarted(true)}
            disabled={!guestName.trim()}
            className="w-full rounded bg-primary text-primary-fg font-bold py-3 text-sm disabled:opacity-50"
          >
            Start ordering
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen pb-28">
      <header className="px-4 py-4 border-b border-border">
        <h1 className="font-black text-lg">{restaurantName}</h1>
        <p className="text-muted text-xs">
          {guestName} · {tableLabel || 'no table'}
        </p>
      </header>

      <div className="sticky top-0 bg-main/95 backdrop-blur border-b border-border px-4 py-2 flex gap-1.5 overflow-x-auto">
        <Pill active={activeCat === 'all'} onClick={() => setActiveCat('all')}>
          All
        </Pill>
        {categories.map((c) => (
          <Pill key={c.id} active={activeCat === c.id} onClick={() => setActiveCat(c.id)}>
            {c.name}
          </Pill>
        ))}
      </div>

      {dealMatches.length > 0 && (
        <div className="p-4 pb-0 space-y-2">
          {dealMatches.map((m) =>
            m.kind === 'match' ? (
              <div
                key={m.deal.id}
                className="rounded-lg border border-ok/50 bg-ok/10 p-3 flex items-center justify-between gap-3"
              >
                <div className="min-w-0">
                  <div className="text-[11px] font-bold uppercase tracking-wide text-ok">
                    You could save {formatCents(m.savingsCents)}
                  </div>
                  <div className="text-sm font-semibold truncate">
                    Your cart matches the {m.deal.name}
                  </div>
                  <div className="text-[11px] text-muted">
                    {formatCents(m.individualTotalCents)} individually → {formatCents(m.deal.price_cents)} as a combo
                  </div>
                </div>
                <button
                  onClick={() => switchToDeal(m)}
                  className="rounded bg-ok text-white font-bold px-3 py-1.5 text-xs shrink-0"
                >
                  Switch & save
                </button>
              </div>
            ) : (
              <div
                key={m.deal.id}
                className="rounded-lg border border-primary/30 bg-primary/5 p-3 flex items-center justify-between gap-3"
              >
                <div className="min-w-0">
                  <div className="text-sm font-semibold truncate">
                    Add {m.missing?.label} to unlock the {m.deal.name}
                  </div>
                  <div className="text-[11px] text-muted">
                    Save {formatCents(m.savingsCents)} vs buying separately
                  </div>
                </div>
                {m.missing?.variantId && (
                  <button
                    onClick={() => addMissingAndSwitch(m)}
                    className="rounded border border-primary text-primary font-bold px-3 py-1.5 text-xs shrink-0"
                  >
                    Add
                  </button>
                )}
              </div>
            ),
          )}
        </div>
      )}

      {deals.length > 0 && activeCat === 'all' && (
        <div className="p-4 pb-0 space-y-2">
          <h2 className="font-black text-sm">Deals</h2>
          {deals.map((d) => {
            // A Build-Your-Own deal (has option groups) opens the sheet,
            // same "a choice to make → sheet, nothing to choose → instant
            // add" rule as items below (spec §5, §7-10) — each distinct
            // selection becomes its own cart line, so no single inline
            // stepper on the card would make sense.
            const hasOptions = (d.deal_option_groups?.length ?? 0) > 0;
            const qty = dealCart[d.id]?.qty ?? 0;
            return (
              <div
                key={d.id}
                className="rounded-lg border border-primary/40 bg-primary/5 p-3 flex items-start justify-between gap-3"
              >
                {d.image_url && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={d.image_url}
                    alt={d.name}
                    className="w-14 h-14 rounded object-cover shrink-0"
                    loading="lazy"
                    onError={(e) => {
                      e.currentTarget.style.display = 'none';
                    }}
                  />
                )}
                <div className="min-w-0 flex-1">
                  <div className="font-semibold text-sm">{d.name}</div>
                  <div className="text-[11px] text-muted truncate">
                    {hasOptions
                      ? d.deal_option_groups!.map((g) => g.name).join(' + ')
                      : d.deal_components
                          .map((c) => `${c.qty}× ${refName(c.menu_variants) || refName(c.menu_items)}`)
                          .join(' + ')}
                  </div>
                  <div className="text-primary font-bold text-sm mt-0.5">
                    {hasOptions ? `from ${formatCents(d.price_cents)}` : formatCents(d.price_cents)}
                  </div>
                </div>
                {hasOptions ? (
                  <button
                    onClick={() => setConfiguringDeal(d)}
                    className="rounded bg-primary text-primary-fg font-bold px-3 py-1.5 text-xs shrink-0"
                  >
                    Choose options
                  </button>
                ) : qty === 0 ? (
                  <button
                    onClick={() => bumpDeal(d, 1)}
                    className="rounded bg-primary text-primary-fg font-bold px-3 py-1.5 text-xs shrink-0"
                  >
                    Add
                  </button>
                ) : (
                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      onClick={() => bumpDeal(d, -1)}
                      className="w-7 h-7 rounded border border-border font-bold"
                    >
                      −
                    </button>
                    <span className="w-4 text-center text-sm font-semibold">{qty}</span>
                    <button
                      onClick={() => bumpDeal(d, 1)}
                      className="w-7 h-7 rounded border border-border font-bold"
                    >
                      +
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      <div className="p-4 grid grid-cols-1 sm:grid-cols-2 gap-2.5">
        {shownItems.length === 0 ? (
          <p className="text-muted text-xs">Nothing here right now.</p>
        ) : (
          shownItems.map((it) => {
            // A choice to make — which size, or any modifier — opens the
            // sheet; a plain single-variant item adds instantly (spec §5).
            const hasChoices = it.variants.length > 1 || it.modifier_groups.length > 0;
            const soleVariant = it.variants[0];
            const soleProduct = !hasChoices ? products.find((p) => p.id === soleVariant.id) : undefined;
            const key = soleProduct ? cartKey(soleProduct.id, []) : '';
            const qty = soleProduct ? (cart[key]?.qty ?? 0) : 0;
            return (
              <div
                key={it.id}
                className="rounded-lg border border-border bg-surface p-3 flex items-center justify-between gap-3"
              >
                {it.image_url && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={it.image_url}
                    alt={it.name}
                    className="w-12 h-12 rounded object-cover shrink-0"
                    loading="lazy"
                    onError={(e) => {
                      e.currentTarget.style.display = 'none';
                    }}
                  />
                )}
                <div className="min-w-0 flex-1">
                  <div className="font-semibold text-sm truncate">{it.name}</div>
                  <div className="text-primary font-bold text-sm">
                    {hasChoices ? `from ${formatCents(it.minPriceCents)}` : formatCents(it.minPriceCents)}
                  </div>
                </div>
                {hasChoices || !soleProduct ? (
                  <button
                    onClick={() => setConfiguring(it)}
                    className="rounded bg-primary text-primary-fg font-bold px-3 py-1.5 text-xs shrink-0"
                  >
                    Choose options
                  </button>
                ) : qty === 0 ? (
                  <button
                    onClick={() => bump(soleProduct, 1)}
                    className="rounded bg-primary text-primary-fg font-bold px-3 py-1.5 text-xs shrink-0"
                  >
                    Add
                  </button>
                ) : (
                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      onClick={() => bump(soleProduct, -1)}
                      className="w-7 h-7 rounded border border-border font-bold"
                    >
                      −
                    </button>
                    <span className="w-4 text-center text-sm font-semibold">{qty}</span>
                    <button
                      onClick={() => bump(soleProduct, 1)}
                      className="w-7 h-7 rounded border border-border font-bold"
                    >
                      +
                    </button>
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>

      {lines.length > 0 && (
        <div className="px-4 pb-2 space-y-1.5">
          <h2 className="font-black text-sm mb-1">Your cart</h2>
          {Object.entries(cart).map(([key, l]) => (
            <div key={key} className="rounded-lg border border-border bg-surface p-2.5 flex items-center justify-between gap-2">
              <div className="min-w-0">
                <div className="text-xs font-semibold truncate">{l.item.name}</div>
                {l.modifierSnapshot.length > 0 && (
                  <div className="text-[11px] text-muted truncate">
                    {l.modifierSnapshot.map((m) => m.name).join(', ')}
                  </div>
                )}
                <div className="text-[11px] text-primary font-semibold">{formatCents(lineUnitPrice(l))} each</div>
              </div>
              <div className="flex items-center gap-1.5 shrink-0">
                <button onClick={() => setLineQty(key, l.qty - 1)} className="w-6 h-6 rounded border border-border font-bold text-xs">
                  −
                </button>
                <span className="w-4 text-center text-xs font-semibold">{l.qty}</span>
                <button onClick={() => setLineQty(key, l.qty + 1)} className="w-6 h-6 rounded border border-border font-bold text-xs">
                  +
                </button>
                <button onClick={() => removeLine(key)} className="text-danger text-[11px] font-semibold ml-1">
                  Remove
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {dealLines.some((d) => d.optionIds.length > 0) && (
        <div className="px-4 pb-2 space-y-1.5">
          <h2 className="font-black text-sm mb-1">Your combos</h2>
          {Object.entries(dealCart)
            .filter(([, d]) => d.optionIds.length > 0)
            .map(([key, d]) => (
              <div key={key} className="rounded-lg border border-border bg-surface p-2.5 flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <div className="text-xs font-semibold truncate">{d.deal.name}</div>
                  {d.optionsSnapshot.length > 0 && (
                    <div className="text-[11px] text-muted truncate">
                      {d.optionsSnapshot.map(dealOptionLabel).join(', ')}
                    </div>
                  )}
                  <div className="text-[11px] text-primary font-semibold">{formatCents(dealLineUnitPrice(d))} each</div>
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  <button onClick={() => setDealLineQty(key, d.qty - 1)} className="w-6 h-6 rounded border border-border font-bold text-xs">
                    −
                  </button>
                  <span className="w-4 text-center text-xs font-semibold">{d.qty}</span>
                  <button onClick={() => setDealLineQty(key, d.qty + 1)} className="w-6 h-6 rounded border border-border font-bold text-xs">
                    +
                  </button>
                  <button onClick={() => removeDealLine(key)} className="text-danger text-[11px] font-semibold ml-1">
                    Remove
                  </button>
                </div>
              </div>
            ))}
        </div>
      )}

      {error && <p className="px-4 text-danger text-xs">{error}</p>}

      {configuring && (
        <ItemSheet
          item={configuring}
          onClose={() => setConfiguring(null)}
          onAdd={addConfigured}
        />
      )}

      {configuringDeal && (
        <DealSheet
          deal={configuringDeal}
          onClose={() => setConfiguringDeal(null)}
          onAdd={addConfiguredDeal}
        />
      )}

      <div className="fixed bottom-0 inset-x-0 border-t border-border bg-surface p-4">
        {count > 0 && (
          <textarea
            value={orderNote}
            onChange={(e) => setOrderNote(e.target.value.slice(0, 500))}
            placeholder="Special instructions (e.g. no onions, pack separately)"
            rows={2}
            className="w-full mb-2 rounded border border-border bg-main px-3 py-2 text-xs outline-none focus:border-primary resize-none"
          />
        )}
        {count > 0 && (
          <div className="flex gap-2 mb-2">
            <input
              value={promo}
              onChange={(e) => {
                setPromo(e.target.value);
                setPromoState({ status: 'idle' });
              }}
              placeholder="Promo code"
              className="flex-1 min-w-0 rounded border border-border bg-main px-3 py-2 text-xs uppercase outline-none focus:border-primary placeholder:normal-case"
            />
            <button
              onClick={checkPromo}
              disabled={!promo.trim() || promoState.status === 'checking'}
              className="rounded border border-border px-3 py-2 text-xs font-semibold disabled:opacity-50"
            >
              {promoState.status === 'checking' ? '…' : 'Apply'}
            </button>
          </div>
        )}
        {promoState.status === 'ok' && (
          <p className="text-ok text-xs mb-2">
            {promoState.kind === 'bogo'
              ? 'Code applied — your Buy One Get One discount will show on the receipt'
              : `Code applied — ${formatCents(promoState.discount)} off`}
          </p>
        )}
        {promoState.status === 'bad' && (
          <p className="text-danger text-xs mb-2">That code isn’t valid for this order.</p>
        )}
        <div className="flex items-center justify-between text-xs text-muted mb-2">
          <span>
            {count} item{count === 1 ? '' : 's'}
            {discount > 0 ? ` · −${formatCents(discount)}` : ''} · tax {formatCents(tax)}
          </span>
          <span className="text-body font-black text-sm">{formatCents(total)}</span>
        </div>
        <button
          onClick={placeOrder}
          disabled={busy || (lines.length === 0 && dealLines.length === 0)}
          className="w-full rounded bg-primary text-primary-fg font-bold py-3 text-sm disabled:opacity-50"
        >
          {busy ? 'Placing…' : 'Place order'}
        </button>
      </div>
    </div>
  );
}

/**
 * Product-detail / customization step (spec §11-12) — shown whenever an item
 * has more than one variant, or any modifier group, so a plain single-
 * variant item with no modifiers never gets an unnecessary extra tap (spec
 * §5). Size/variant is presented exactly like a required modifier group —
 * one consistent picker pattern rather than two different UI idioms.
 * Displayed price is provisional; the server always re-prices and
 * re-validates every option (and the variant itself) on submit.
 */
function ItemSheet({
  item,
  onClose,
  onAdd,
}: {
  item: BrowseItem;
  onClose: () => void;
  onAdd: (item: Product, modifierIds: string[], snapshot: ModOption[]) => void;
}) {
  const [variantId, setVariantId] = useState(item.variants[0]?.id ?? '');
  const [selected, setSelected] = useState<Record<string, string[]>>({}); // group id -> option ids

  function toggle(group: ModGroup, optionId: string) {
    setSelected((s) => {
      const cur = s[group.id] ?? [];
      if (group.kind === 'required_single' || group.kind === 'optional_single') {
        return { ...s, [group.id]: cur[0] === optionId ? [] : [optionId] };
      }
      const has = cur.includes(optionId);
      if (has) return { ...s, [group.id]: cur.filter((id) => id !== optionId) };
      if (group.max_select != null && cur.length >= group.max_select) return s; // at the cap
      return { ...s, [group.id]: [...cur, optionId] };
    });
  }

  const variant = item.variants.find((v) => v.id === variantId) ?? item.variants[0];
  const allOptions = new Map(item.modifier_groups.flatMap((g) => g.modifier_options.map((o) => [o.id, o])));
  const chosenIds = Object.values(selected).flat();
  const chosenOptions = chosenIds.map((id) => allOptions.get(id)).filter((o): o is ModOption => !!o);
  const addonTotal = chosenOptions.reduce((s, o) => s + o.price_cents, 0);
  const requiredUnmet = item.modifier_groups.some(
    (g) => g.kind === 'required_single' && (selected[g.id]?.length ?? 0) < 1,
  );

  function add() {
    if (!variant) return;
    const product: Product = {
      id: variant.id,
      item_id: item.id,
      name: variant.name === 'Regular' ? item.name : `${item.name} · ${variant.name}`,
      price_cents: variant.price_cents,
      category_id: item.category_id,
      image_url: item.image_url,
      modifier_groups: item.modifier_groups,
    };
    onAdd(product, chosenIds, chosenOptions);
  }

  return (
    <div className="fixed inset-0 z-40 bg-black/40 flex items-end sm:items-center sm:justify-center" onClick={onClose}>
      <div
        className="w-full sm:max-w-sm bg-surface rounded-t-2xl sm:rounded-2xl max-h-[85vh] overflow-y-auto p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between mb-1">
          <h2 className="font-black text-base">{item.name}</h2>
          <button onClick={onClose} className="text-muted text-lg leading-none">
            ✕
          </button>
        </div>
        <p className="text-primary font-bold text-sm mb-4">{formatCents(variant?.price_cents ?? item.minPriceCents)}</p>

        <div className="space-y-5">
          {item.variants.length > 1 && (
            <div>
              <div className="flex items-baseline justify-between mb-2">
                <h3 className="font-bold text-sm">Choose size</h3>
                <span className="text-[11px] text-muted">Required</span>
              </div>
              <div className="space-y-1.5">
                {item.variants.map((v) => {
                  const checked = v.id === variantId;
                  return (
                    <button
                      key={v.id}
                      onClick={() => setVariantId(v.id)}
                      className={`w-full flex items-center justify-between rounded border px-3 py-2 text-xs text-left ${
                        checked ? 'border-primary bg-primary/5' : 'border-border'
                      }`}
                    >
                      <span className="flex items-center gap-2">
                        <span
                          className={`w-4 h-4 grid place-items-center rounded-full border ${
                            checked ? 'bg-primary border-primary text-primary-fg' : 'border-border'
                          }`}
                        >
                          {checked ? '✓' : ''}
                        </span>
                        {v.name}
                      </span>
                      <span className="text-muted">{formatCents(v.price_cents)}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {item.modifier_groups.map((g) => (
            <div key={g.id}>
              <div className="flex items-baseline justify-between mb-2">
                <h3 className="font-bold text-sm">{g.name}</h3>
                <span className="text-[11px] text-muted">
                  {g.kind === 'required_single'
                    ? 'Required'
                    : g.kind === 'multi' && g.max_select
                      ? `Up to ${g.max_select}`
                      : 'Optional'}
                </span>
              </div>
              <div className="space-y-1.5">
                {g.modifier_options.map((o) => {
                  const checked = (selected[g.id] ?? []).includes(o.id);
                  return (
                    <button
                      key={o.id}
                      onClick={() => toggle(g, o.id)}
                      className={`w-full flex items-center justify-between rounded border px-3 py-2 text-xs text-left ${
                        checked ? 'border-primary bg-primary/5' : 'border-border'
                      }`}
                    >
                      <span className="flex items-center gap-2">
                        <span
                          className={`w-4 h-4 grid place-items-center rounded-${g.kind === 'multi' ? 'sm' : 'full'} border ${
                            checked ? 'bg-primary border-primary text-primary-fg' : 'border-border'
                          }`}
                        >
                          {checked ? '✓' : ''}
                        </span>
                        {o.name}
                      </span>
                      <span className="text-muted">{o.price_cents > 0 ? `+${formatCents(o.price_cents)}` : 'free'}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>

        <button
          onClick={add}
          disabled={requiredUnmet || !variant}
          className="w-full mt-6 rounded bg-primary text-primary-fg font-bold py-3 text-sm disabled:opacity-50"
        >
          Add — {formatCents((variant?.price_cents ?? 0) + addonTotal)}
        </button>
      </div>
    </div>
  );
}

/**
 * Build-Your-Own-Combo sheet (spec §7-10) — one consistent picker per
 * option group, same idiom as ItemSheet's modifier groups: a max-1 group
 * behaves like a required radio choice, anything wider is a capped
 * multi-select. Displayed price is provisional; place_order() always
 * re-prices and re-validates every selection on submit.
 */
function DealSheet({
  deal,
  onClose,
  onAdd,
}: {
  deal: DealLite;
  onClose: () => void;
  onAdd: (deal: DealLite, optionIds: string[], snapshot: DealOptionItem[]) => void;
}) {
  const groups = deal.deal_option_groups ?? [];
  const [selected, setSelected] = useState<Record<string, string[]>>(() =>
    Object.fromEntries(
      groups.map((g) => [g.id, g.deal_option_items.filter((o) => o.is_default).slice(0, g.max_select ?? 1).map((o) => o.id)]),
    ),
  );

  function toggle(group: DealOptionGroup, optionId: string) {
    setSelected((s) => {
      const cur = s[group.id] ?? [];
      if (group.max_select === 1) {
        return { ...s, [group.id]: cur[0] === optionId ? [] : [optionId] };
      }
      const has = cur.includes(optionId);
      if (has) return { ...s, [group.id]: cur.filter((id) => id !== optionId) };
      if (group.max_select != null && cur.length >= group.max_select) return s; // at the cap
      return { ...s, [group.id]: [...cur, optionId] };
    });
  }

  const allOptions = new Map(groups.flatMap((g) => g.deal_option_items.map((o) => [o.id, o])));
  const chosenIds = Object.values(selected).flat();
  const chosenOptions = chosenIds.map((id) => allOptions.get(id)).filter((o): o is DealOptionItem => !!o);
  const addonTotal = chosenOptions.reduce((s, o) => s + o.price_adjustment_cents * o.qty, 0);
  const requiredUnmet = groups.some((g) => (selected[g.id]?.length ?? 0) < g.min_select);

  return (
    <div className="fixed inset-0 z-40 bg-black/40 flex items-end sm:items-center sm:justify-center" onClick={onClose}>
      <div
        className="w-full sm:max-w-sm bg-surface rounded-t-2xl sm:rounded-2xl max-h-[85vh] overflow-y-auto p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between mb-1">
          <h2 className="font-black text-base">{deal.name}</h2>
          <button onClick={onClose} className="text-muted text-lg leading-none">
            ✕
          </button>
        </div>
        <p className="text-primary font-bold text-sm mb-4">{formatCents(deal.price_cents)}</p>

        <div className="space-y-5">
          {groups.map((g) => (
            <div key={g.id}>
              <div className="flex items-baseline justify-between mb-2">
                <h3 className="font-bold text-sm">{g.name}</h3>
                <span className="text-[11px] text-muted">
                  {g.min_select > 0
                    ? 'Required'
                    : g.max_select && g.max_select > 1
                      ? `Up to ${g.max_select}`
                      : 'Optional'}
                </span>
              </div>
              <div className="space-y-1.5">
                {g.deal_option_items.map((o) => {
                  const checked = (selected[g.id] ?? []).includes(o.id);
                  const addon = o.price_adjustment_cents * o.qty;
                  return (
                    <button
                      key={o.id}
                      onClick={() => toggle(g, o.id)}
                      className={`w-full flex items-center justify-between rounded border px-3 py-2 text-xs text-left ${
                        checked ? 'border-primary bg-primary/5' : 'border-border'
                      }`}
                    >
                      <span className="flex items-center gap-2">
                        <span
                          className={`w-4 h-4 grid place-items-center rounded-${g.max_select === 1 ? 'full' : 'sm'} border ${
                            checked ? 'bg-primary border-primary text-primary-fg' : 'border-border'
                          }`}
                        >
                          {checked ? '✓' : ''}
                        </span>
                        {dealOptionLabel(o)}
                      </span>
                      <span className="text-muted">{addon > 0 ? `+${formatCents(addon)}` : 'free'}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>

        <button
          onClick={() => onAdd(deal, chosenIds, chosenOptions)}
          disabled={requiredUnmet}
          className="w-full mt-6 rounded bg-primary text-primary-fg font-bold py-3 text-sm disabled:opacity-50"
        >
          Add — {formatCents(deal.price_cents + addonTotal)}
        </button>
      </div>
    </div>
  );
}

function Pill({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`px-3 py-1.5 rounded text-xs font-semibold whitespace-nowrap ${
        active ? 'bg-primary text-primary-fg' : 'bg-surface border border-border'
      }`}
    >
      {children}
    </button>
  );
}
