'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { formatCents } from '@/lib/format';

export type MenuCategory = { id: string; name: string; sort_order: number };
export type MenuItem = {
  id: string;
  name: string;
  price_cents: number;
  category_id: string | null;
};

const TAX_RATE_BPS = 800;

export function StorefrontClient({
  slug,
  restaurantName,
  table,
  categories,
  items,
}: {
  slug: string;
  restaurantName: string;
  table: string | null;
  categories: MenuCategory[];
  items: MenuItem[];
}) {
  const router = useRouter();
  const [guestName, setGuestName] = useState('');
  const [tableLabel, setTableLabel] = useState(table ?? '');
  const [started, setStarted] = useState(false);

  const [activeCat, setActiveCat] = useState('all');
  const [cart, setCart] = useState<Record<string, { item: MenuItem; qty: number }>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [promo, setPromo] = useState('');
  const [promoState, setPromoState] = useState<
    { status: 'idle' | 'checking' } | { status: 'ok'; code: string; discount: number } | { status: 'bad' }
  >({ status: 'idle' });

  const shown = items.filter((i) => activeCat === 'all' || i.category_id === activeCat);
  const lines = Object.values(cart);
  const subtotal = useMemo(
    () => lines.reduce((s, l) => s + l.item.price_cents * l.qty, 0),
    [lines],
  );
  const discount = promoState.status === 'ok' ? Math.min(promoState.discount, subtotal) : 0;
  const tax = Math.round(((subtotal - discount) * TAX_RATE_BPS) / 10000);
  const total = subtotal - discount + tax;
  const count = lines.reduce((s, l) => s + l.qty, 0);

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
          ? { status: 'ok', code, discount: body.discount_cents }
          : { status: 'bad' },
      );
    } catch {
      setPromoState({ status: 'bad' });
    }
  }

  function bump(item: MenuItem, delta: number) {
    setError(null);
    setPromoState((s) => (s.status === 'ok' || s.status === 'bad' ? { status: 'idle' } : s));
    setCart((c) => {
      const next = { ...c };
      const qty = (next[item.id]?.qty ?? 0) + delta;
      if (qty <= 0) delete next[item.id];
      else next[item.id] = { item, qty };
      return next;
    });
  }

  async function placeOrder() {
    if (lines.length === 0) return;
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
          lines: lines.map((l) => ({ menu_item_id: l.item.id, qty: l.qty })),
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

      <div className="p-4 grid grid-cols-1 sm:grid-cols-2 gap-2.5">
        {shown.length === 0 ? (
          <p className="text-muted text-xs">Nothing here right now.</p>
        ) : (
          shown.map((it) => {
            const qty = cart[it.id]?.qty ?? 0;
            return (
              <div
                key={it.id}
                className="rounded-lg border border-border bg-surface p-3 flex items-center justify-between"
              >
                <div className="min-w-0">
                  <div className="font-semibold text-sm truncate">{it.name}</div>
                  <div className="text-primary font-bold text-sm">
                    {formatCents(it.price_cents)}
                  </div>
                </div>
                {qty === 0 ? (
                  <button
                    onClick={() => bump(it, 1)}
                    className="rounded bg-primary text-primary-fg font-bold px-3 py-1.5 text-xs shrink-0"
                  >
                    Add
                  </button>
                ) : (
                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      onClick={() => bump(it, -1)}
                      className="w-7 h-7 rounded border border-border font-bold"
                    >
                      −
                    </button>
                    <span className="w-4 text-center text-sm font-semibold">{qty}</span>
                    <button
                      onClick={() => bump(it, 1)}
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

      {error && <p className="px-4 text-danger text-xs">{error}</p>}

      <div className="fixed bottom-0 inset-x-0 border-t border-border bg-surface p-4">
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
            Code applied — {formatCents(promoState.discount)} off
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
          disabled={busy || lines.length === 0}
          className="w-full rounded bg-primary text-primary-fg font-bold py-3 text-sm disabled:opacity-50"
        >
          {busy ? 'Placing…' : 'Place order'}
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
