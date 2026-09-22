'use client';

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowRight } from 'lucide-react';
import { formatCents } from '@/lib/format';
import { CustomerAiChat } from './CustomerAiChat';
import { cssVarsFromTokens, themeFromBrandKit, type BrandKit } from '@/lib/theme';
import {
  cartKey,
  dealsContainingItem,
  dealLineUnitPrice,
  findDealMatches,
  friendlyOrderError,
  relatedItems as relatedItemsFor,
  toBrowseItems,
  toProducts,
  type BrowseItem,
  type CartLine,
  type DealCartLine,
  type DealLite,
  type DealMatch,
  type DealOptionItem,
  type MenuCategory,
  type MenuItem,
  type ModOption,
  type Product,
} from './menuTypes';
import { Header } from './components/Header';
import { CategoryNav, type NavSection } from './components/CategoryNav';
import { ProductCard } from './components/ProductCard';
import { DealCard } from './components/DealCard';
import { ItemSheet } from './components/ItemSheet';
import { DealSheet } from './components/DealSheet';
import { CartContents } from './components/CartContents';
import { MobileCartBar } from './components/MobileCartBar';

export type { MenuCategory, MenuItem, DealLite, Product, ModOption, DealMatch };

const TAX_RATE_BPS = 800;
const NAV_HEIGHT = 52;

export function StorefrontClient({
  slug,
  restaurantName,
  table,
  categories,
  items,
  deals,
  brandKit,
}: {
  slug: string;
  restaurantName: string;
  table: string | null;
  categories: MenuCategory[];
  items: MenuItem[];
  deals: DealLite[];
  brandKit?: BrandKit | null;
}) {
  const router = useRouter();
  // Scoped to this render tree via inline CSS custom properties (not
  // document.documentElement/localStorage) — SSR-safe, no client-side
  // theme provider needed, and inherently one-restaurant-per-request so
  // it can never bleed into another tenant's page in the same browser.
  const brandStyle = useMemo(
    () => cssVarsFromTokens(themeFromBrandKit(brandKit ?? null).tokens) as CSSProperties,
    [brandKit],
  );
  const logoUrl = brandKit?.logo_url ?? null;
  const [guestName, setGuestName] = useState('');
  const [tableLabel, setTableLabel] = useState(table ?? '');
  const [started, setStarted] = useState(false);

  const [searchQuery, setSearchQuery] = useState('');
  const [activeCat, setActiveCat] = useState<string>('cat-deals');
  const [cartOpen, setCartOpen] = useState(false);
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
  // What's actually browsed: one card per item.
  const browseItems = useMemo(() => toBrowseItems(items), [items]);

  const tagline = categories.length > 0 ? categories.slice(0, 4).map((c) => c.name).join(' • ') : null;

  const sections: NavSection[] = useMemo(() => {
    const out: NavSection[] = [];
    if (deals.length > 0) out.push({ id: 'cat-deals', label: 'Deals' });
    for (const c of categories) {
      if (browseItems.some((i) => i.category_id === c.id)) out.push({ id: `cat-${c.id}`, label: c.name });
    }
    return out;
  }, [categories, browseItems, deals.length]);

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

  // What the customer AI assistant is told is in the cart — plain (no-
  // modifier) lines only, same pool findDealMatches() itself uses, pooled
  // by variant id. IDs and quantities only; the assistant's backend
  // re-reads every price itself, never trusts a client-asserted number.
  const cartSnapshot = useMemo(() => {
    const pool = new Map<string, number>();
    for (const l of Object.values(cart)) {
      if (l.modifierIds.length > 0) continue;
      pool.set(l.item.id, (pool.get(l.item.id) ?? 0) + l.qty);
    }
    return [...pool.entries()].map(([variant_id, qty]) => ({ variant_id, qty }));
  }, [cart]);

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
        setError(friendlyOrderError(body.message ?? body.error));
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

  // ── Scroll-spy: keep the active category pill in sync with whatever
  // section is actually on screen, offset for the sticky header + nav.
  const headerRef = useRef<HTMLDivElement | null>(null);
  const [headerHeight, setHeaderHeight] = useState(0);
  // Measured synchronously (not just via ResizeObserver's first callback,
  // which some environments delay indefinitely for a backgrounded/inactive
  // tab) so the sticky nav offset and scroll-spy margins are correct from
  // the very first paint. ResizeObserver stays on to track later changes
  // (e.g. the header wrapping to a second line on a narrow viewport).
  useLayoutEffect(() => {
    const el = headerRef.current;
    if (!el) return;
    setHeaderHeight(el.getBoundingClientRect().height);
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((entries) => setHeaderHeight(entries[0].contentRect.height));
    ro.observe(el);
    return () => ro.disconnect();
    // `started` gates whether headerRef's div exists at all (the pre-order
    // gate has no header) — re-run once it flips true and the real header
    // mounts, instead of only ever firing against the gate's first paint.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [started]);
  const stickyOffset = headerHeight;
  const scrollMarginTop = headerHeight + NAV_HEIGHT + 12;

  useEffect(() => {
    if (sections.length === 0 || searchQuery.trim()) return;
    const ids = sections.map((s) => s.id);
    const visible = new Set<string>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          const id = (e.target as HTMLElement).dataset.menuSection;
          if (!id) continue;
          if (e.isIntersecting) visible.add(id);
          else visible.delete(id);
        }
        const first = ids.find((id) => visible.has(id));
        if (first) setActiveCat(first);
      },
      { rootMargin: `-${scrollMarginTop + 1}px 0px -65% 0px`, threshold: 0 },
    );
    for (const id of ids) {
      const el = document.querySelector(`[data-menu-section="${id}"]`);
      if (el) observer.observe(el);
    }
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sections, scrollMarginTop, searchQuery]);

  function pickCategory(id: string) {
    setActiveCat(id);
    document.querySelector(`[data-menu-section="${id}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function openItem(item: BrowseItem) {
    const hasChoices = item.variants.length > 1 || item.modifier_groups.length > 0;
    if (!hasChoices) {
      const product = products.find((p) => p.id === item.variants[0]?.id);
      if (product) return bump(product, 1);
    }
    setConfiguring(item);
  }

  const q = searchQuery.trim().toLowerCase();
  const searchResultItems = q
    ? browseItems.filter((i) => i.name.toLowerCase().includes(q) || (i.description ?? '').toLowerCase().includes(q))
    : [];
  const searchResultDeals = q ? deals.filter((d) => d.name.toLowerCase().includes(q)) : [];

  if (!started) {
    return (
      <div className="min-h-screen grid place-items-center px-6" style={brandStyle}>
        <div className="w-full max-w-sm">
          {logoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={logoUrl} alt={`${restaurantName} logo`} className="h-16 w-16 rounded-2xl object-contain bg-surface border border-border p-2 mb-4" />
          ) : null}
          <h1 className="text-2xl font-black leading-tight">Welcome to {restaurantName}</h1>
          <p className="text-muted text-sm mb-7 mt-1">Order from your table — no sign-up.</p>
          <label className="block mb-3">
            <span className="text-muted text-xs font-bold">Your name</span>
            <input
              autoFocus
              value={guestName}
              onChange={(e) => setGuestName(e.target.value)}
              className="mt-1.5 w-full rounded-xl border border-border bg-surface px-3.5 py-3 text-sm outline-none focus:border-primary transition-colors"
            />
          </label>
          <label className="block mb-7">
            <span className="text-muted text-xs font-bold">Table</span>
            <input
              value={tableLabel}
              onChange={(e) => setTableLabel(e.target.value)}
              className="mt-1.5 w-full rounded-xl border border-border bg-surface px-3.5 py-3 text-sm outline-none focus:border-primary transition-colors"
            />
          </label>
          <button
            onClick={() => guestName.trim() && setStarted(true)}
            disabled={!guestName.trim()}
            className="w-full rounded-full bg-primary text-primary-fg font-black py-3.5 text-sm disabled:opacity-50 flex items-center justify-center gap-1.5 active:scale-[0.99] transition-transform"
          >
            Start ordering <ArrowRight size={15} />
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen pb-28 lg:pb-10" style={brandStyle}>
      <div className="lg:grid lg:grid-cols-[minmax(0,1fr)_380px] lg:gap-6 lg:max-w-[1400px] lg:mx-auto lg:px-6 lg:pt-6 lg:items-start">
        <div className="min-w-0">
          <div ref={headerRef} className="sticky top-0 z-20 bg-main">
            <Header
              restaurantName={restaurantName}
              logoUrl={logoUrl}
              tagline={tagline}
              guestName={guestName}
              tableLabel={tableLabel}
              searchQuery={searchQuery}
              onSearchChange={setSearchQuery}
            />
          </div>

          {q ? (
            <div className="p-4">
              <h2 className="font-black text-sm mb-3">
                {searchResultItems.length + searchResultDeals.length === 0
                  ? `No matches for "${searchQuery}"`
                  : `Results for "${searchQuery}"`}
              </h2>
              {searchResultDeals.length > 0 && (
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mb-4">
                  {searchResultDeals.map((d) => (
                    <DealCard
                      key={d.id}
                      deal={d}
                      qty={dealCart[d.id]?.qty ?? 0}
                      onOpenSheet={() => setConfiguringDeal(d)}
                      onBump={(delta) => bumpDeal(d, delta)}
                    />
                  ))}
                </div>
              )}
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                {searchResultItems.map((it) => {
                  const soleProduct = it.variants.length === 1 && it.modifier_groups.length === 0
                    ? products.find((p) => p.id === it.variants[0].id)
                    : undefined;
                  const key = soleProduct ? cartKey(soleProduct.id, []) : '';
                  return (
                    <ProductCard
                      key={it.id}
                      item={it}
                      soleProduct={soleProduct}
                      qty={soleProduct ? (cart[key]?.qty ?? 0) : 0}
                      onOpenSheet={() => openItem(it)}
                      onBump={(delta) => soleProduct && bump(soleProduct, delta)}
                    />
                  );
                })}
              </div>
            </div>
          ) : (
            <>
              <CategoryNav sections={sections} activeId={activeCat} onPick={pickCategory} topOffset={stickyOffset} />

              {dealMatches.length > 0 && (
                <div className="p-4 pb-0 space-y-2">
                  {dealMatches.map((m) =>
                    m.kind === 'match' ? (
                      <div
                        key={m.deal.id}
                        className="rounded-xl border border-ok/50 bg-ok/10 p-3.5 flex items-center justify-between gap-3"
                      >
                        <div className="min-w-0">
                          <div className="text-[11px] font-black uppercase tracking-wide text-ok">
                            You could save {formatCents(m.savingsCents)}
                          </div>
                          <div className="text-sm font-bold truncate">Your cart matches the {m.deal.name}</div>
                          <div className="text-[11px] text-muted">
                            {formatCents(m.individualTotalCents)} individually → {formatCents(m.deal.price_cents)} as a combo
                          </div>
                        </div>
                        <button
                          onClick={() => switchToDeal(m)}
                          className="rounded-full bg-ok text-white font-bold px-3.5 py-2 text-xs shrink-0"
                        >
                          Switch & save
                        </button>
                      </div>
                    ) : (
                      <div
                        key={m.deal.id}
                        className="rounded-xl border border-primary/30 bg-primary/5 p-3.5 flex items-center justify-between gap-3"
                      >
                        <div className="min-w-0">
                          <div className="text-sm font-bold truncate">Add {m.missing?.label} to unlock the {m.deal.name}</div>
                          <div className="text-[11px] text-muted">Save {formatCents(m.savingsCents)} vs buying separately</div>
                        </div>
                        {m.missing?.variantId && (
                          <button
                            onClick={() => addMissingAndSwitch(m)}
                            className="rounded-full border border-primary text-primary font-bold px-3.5 py-2 text-xs shrink-0"
                          >
                            Add
                          </button>
                        )}
                      </div>
                    ),
                  )}
                </div>
              )}

              {deals.length > 0 && (
                <div data-menu-section="cat-deals" style={{ scrollMarginTop }} className="p-4 pb-1">
                  <h2 className="font-black text-base mb-2.5">Deals</h2>
                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                    {deals.map((d) => (
                      <DealCard
                        key={d.id}
                        deal={d}
                        qty={dealCart[d.id]?.qty ?? 0}
                        onOpenSheet={() => setConfiguringDeal(d)}
                        onBump={(delta) => bumpDeal(d, delta)}
                      />
                    ))}
                  </div>
                </div>
              )}

              {categories.map((c) => {
                const catItems = browseItems.filter((i) => i.category_id === c.id);
                if (catItems.length === 0) return null;
                return (
                  <div key={c.id} data-menu-section={`cat-${c.id}`} style={{ scrollMarginTop }} className="p-4 pb-1">
                    <h2 className="font-black text-base mb-2.5">{c.name}</h2>
                    <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                      {catItems.map((it) => {
                        const soleProduct = it.variants.length === 1 && it.modifier_groups.length === 0
                          ? products.find((p) => p.id === it.variants[0].id)
                          : undefined;
                        const key = soleProduct ? cartKey(soleProduct.id, []) : '';
                        return (
                          <ProductCard
                            key={it.id}
                            item={it}
                            soleProduct={soleProduct}
                            qty={soleProduct ? (cart[key]?.qty ?? 0) : 0}
                            onOpenSheet={() => openItem(it)}
                            onBump={(delta) => soleProduct && bump(soleProduct, delta)}
                          />
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </>
          )}

          {error && <p className="px-4 pt-2 text-danger text-xs">{error}</p>}
        </div>

        {/* Desktop: persistent right-side cart rail, pinned below the sticky
            header (same offset the scroll-spy uses). Mobile uses the sticky
            bar + full-screen sheet below instead. */}
        <aside
          className="hidden lg:block sticky rounded-2xl border border-border bg-surface overflow-hidden"
          style={{ top: stickyOffset + 24, height: `calc(100vh - ${stickyOffset + 48}px)` }}
        >
          <CartContents
            cart={cart}
            dealCart={dealCart}
            lineUnitPrice={lineUnitPrice}
            dealLineUnitPrice={dealLineUnitPrice}
            setLineQty={setLineQty}
            removeLine={removeLine}
            setDealLineQty={setDealLineQty}
            removeDealLine={removeDealLine}
            orderNote={orderNote}
            setOrderNote={setOrderNote}
            promo={promo}
            setPromo={setPromo}
            promoState={promoState}
            checkPromo={checkPromo}
            subtotal={subtotal}
            discount={discount}
            tax={tax}
            total={total}
            count={count}
            error={error}
            busy={busy}
            placeOrder={placeOrder}
            variant="panel"
          />
        </aside>
      </div>

      <MobileCartBar count={count} total={total} onOpen={() => setCartOpen(true)} />

      {cartOpen && (
        <div className="lg:hidden fixed inset-0 z-40 bg-black/50" onClick={() => setCartOpen(false)}>
          <div
            className="absolute inset-x-0 bottom-0 top-16 bg-surface rounded-t-2xl overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            <CartContents
              cart={cart}
              dealCart={dealCart}
              lineUnitPrice={lineUnitPrice}
              dealLineUnitPrice={dealLineUnitPrice}
              setLineQty={setLineQty}
              removeLine={removeLine}
              setDealLineQty={setDealLineQty}
              removeDealLine={removeDealLine}
              orderNote={orderNote}
              setOrderNote={setOrderNote}
              promo={promo}
              setPromo={setPromo}
              promoState={promoState}
              checkPromo={checkPromo}
              subtotal={subtotal}
              discount={discount}
              tax={tax}
              total={total}
              count={count}
              error={error}
              busy={busy}
              placeOrder={placeOrder}
              onClose={() => setCartOpen(false)}
              variant="sheet"
            />
          </div>
        </div>
      )}

      {configuring && (
        <ItemSheet
          key={configuring.id}
          item={configuring}
          relatedItems={relatedItemsFor(browseItems, configuring)}
          relatedDeals={dealsContainingItem(deals, configuring.id)}
          onClose={() => setConfiguring(null)}
          onAdd={addConfigured}
          onPickRelated={(item) => openItem(item)}
          onPickDeal={(deal) => {
            setConfiguring(null);
            setConfiguringDeal(deal);
          }}
        />
      )}

      {configuringDeal && (
        <DealSheet deal={configuringDeal} onClose={() => setConfiguringDeal(null)} onAdd={addConfiguredDeal} />
      )}

      <CustomerAiChat
        slug={slug}
        restaurantName={restaurantName}
        products={products}
        deals={deals}
        cartSnapshot={cartSnapshot}
        dealMatches={dealMatches}
        onAddPlain={(product, qty) => bump(product, qty)}
        onAddConfigured={(product, modifierIds, modifierSnapshot) => addConfigured(product, modifierIds, modifierSnapshot)}
        onUseDealMatch={(match) => switchToDeal(match)}
        onUseAlmostMatch={(match) => addMissingAndSwitch(match)}
        onAddDealPlain={(deal, qty) => bumpDeal(deal, qty)}
        hideTrigger={cartOpen || !!configuring || !!configuringDeal}
      />
    </div>
  );
}
