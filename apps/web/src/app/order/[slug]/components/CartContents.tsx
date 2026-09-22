'use client';

import { Minus, Plus, Trash2, X } from 'lucide-react';
import { formatCents } from '@/lib/format';
import { dealOptionLabel, type CartLine, type DealCartLine } from '../menuTypes';

type PromoState =
  | { status: 'idle' | 'checking' }
  | { status: 'ok'; code: string; discount: number; kind: 'percent' | 'fixed' | 'bogo' }
  | { status: 'bad' };

export function CartContents({
  cart,
  dealCart,
  lineUnitPrice,
  dealLineUnitPrice,
  setLineQty,
  removeLine,
  setDealLineQty,
  removeDealLine,
  orderNote,
  setOrderNote,
  promo,
  setPromo,
  promoState,
  checkPromo,
  subtotal,
  discount,
  tax,
  total,
  count,
  error,
  busy,
  placeOrder,
  onClose,
  variant = 'panel',
}: {
  cart: Record<string, CartLine>;
  dealCart: Record<string, DealCartLine>;
  lineUnitPrice: (l: CartLine) => number;
  dealLineUnitPrice: (d: DealCartLine) => number;
  setLineQty: (key: string, qty: number) => void;
  removeLine: (key: string) => void;
  setDealLineQty: (key: string, qty: number) => void;
  removeDealLine: (key: string) => void;
  orderNote: string;
  setOrderNote: (v: string) => void;
  promo: string;
  setPromo: (v: string) => void;
  promoState: PromoState;
  checkPromo: () => void;
  subtotal: number;
  discount: number;
  tax: number;
  total: number;
  count: number;
  error: string | null;
  busy: boolean;
  placeOrder: () => void;
  onClose?: () => void;
  variant?: 'panel' | 'sheet';
}) {
  const itemLines = Object.entries(cart);
  const dealLines = Object.entries(dealCart);
  const empty = itemLines.length === 0 && dealLines.length === 0;

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-4 py-3.5 border-b border-border shrink-0">
        <h2 className="font-black text-base">Your Order</h2>
        {onClose && (
          <button onClick={onClose} className="text-muted hover:text-body" aria-label="Close cart">
            <X size={19} />
          </button>
        )}
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-3">
        {empty ? (
          <p className="text-muted text-sm text-center py-10">Your cart is empty — add something from the menu.</p>
        ) : (
          <div className="space-y-2">
            {itemLines.map(([key, l]) => (
              <div key={key} className="rounded-lg border border-border bg-main p-2.5 flex items-start gap-2">
                {l.item.image_url && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={l.item.image_url} alt="" className="w-11 h-11 rounded object-cover shrink-0" />
                )}
                <div className="min-w-0 flex-1">
                  <div className="text-xs font-bold truncate">{l.item.name}</div>
                  {l.modifierSnapshot.length > 0 && (
                    <div className="text-[11px] text-muted truncate">{l.modifierSnapshot.map((m) => m.name).join(', ')}</div>
                  )}
                  <div className="text-[11px] text-primary font-bold mt-0.5">{formatCents(lineUnitPrice(l))} each</div>
                </div>
                <div className="flex flex-col items-end gap-1.5 shrink-0">
                  <button onClick={() => removeLine(key)} className="text-muted hover:text-danger" aria-label="Remove item">
                    <Trash2 size={13} />
                  </button>
                  <div className="flex items-center gap-1.5">
                    <button
                      onClick={() => setLineQty(key, l.qty - 1)}
                      className="w-6 h-6 rounded-full border border-border grid place-items-center active:scale-90 transition-transform"
                    >
                      <Minus size={11} strokeWidth={2.5} />
                    </button>
                    <span className="w-4 text-center text-xs font-black">{l.qty}</span>
                    <button
                      onClick={() => setLineQty(key, l.qty + 1)}
                      className="w-6 h-6 rounded-full border border-border grid place-items-center active:scale-90 transition-transform"
                    >
                      <Plus size={11} strokeWidth={2.5} />
                    </button>
                  </div>
                </div>
              </div>
            ))}

            {dealLines.map(([key, d]) => (
              <div key={key} className="rounded-lg border border-primary/30 bg-primary/5 p-2.5 flex items-start gap-2">
                {d.deal.image_url && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={d.deal.image_url} alt="" className="w-11 h-11 rounded object-cover shrink-0" />
                )}
                <div className="min-w-0 flex-1">
                  <div className="text-xs font-bold truncate">{d.deal.name}</div>
                  {d.optionsSnapshot.length > 0 && (
                    <div className="text-[11px] text-muted truncate">
                      {d.optionsSnapshot.map(dealOptionLabel).join(', ')}
                    </div>
                  )}
                  <div className="text-[11px] text-primary font-bold mt-0.5">{formatCents(dealLineUnitPrice(d))} each</div>
                </div>
                <div className="flex flex-col items-end gap-1.5 shrink-0">
                  <button onClick={() => removeDealLine(key)} className="text-muted hover:text-danger" aria-label="Remove combo">
                    <Trash2 size={13} />
                  </button>
                  <div className="flex items-center gap-1.5">
                    <button
                      onClick={() => setDealLineQty(key, d.qty - 1)}
                      className="w-6 h-6 rounded-full border border-border grid place-items-center active:scale-90 transition-transform"
                    >
                      <Minus size={11} strokeWidth={2.5} />
                    </button>
                    <span className="w-4 text-center text-xs font-black">{d.qty}</span>
                    <button
                      onClick={() => setDealLineQty(key, d.qty + 1)}
                      className="w-6 h-6 rounded-full border border-border grid place-items-center active:scale-90 transition-transform"
                    >
                      <Plus size={11} strokeWidth={2.5} />
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {!empty && (
        <div className="shrink-0 border-t border-border p-4 space-y-2.5">
          <textarea
            value={orderNote}
            onChange={(e) => setOrderNote(e.target.value.slice(0, 500))}
            placeholder="Special instructions (e.g. no onions, pack separately)"
            rows={2}
            className="w-full rounded-lg border border-border bg-main px-3 py-2 text-xs outline-none focus:border-primary resize-none"
          />

          <div className="flex gap-2">
            <input
              value={promo}
              onChange={(e) => {
                setPromo(e.target.value);
              }}
              placeholder="Promo code"
              className="flex-1 min-w-0 rounded-lg border border-border bg-main px-3 py-2 text-xs uppercase outline-none focus:border-primary placeholder:normal-case"
            />
            <button
              onClick={checkPromo}
              disabled={!promo.trim() || promoState.status === 'checking'}
              className="rounded-lg border border-border px-3.5 py-2 text-xs font-bold disabled:opacity-50 hover:border-primary/40"
            >
              {promoState.status === 'checking' ? '…' : 'Apply'}
            </button>
          </div>
          {promoState.status === 'ok' && (
            <p className="text-ok text-xs">
              {promoState.kind === 'bogo'
                ? 'Code applied — your Buy One Get One discount will show on the receipt'
                : `Code applied — ${formatCents(promoState.discount)} off`}
            </p>
          )}
          {promoState.status === 'bad' && <p className="text-danger text-xs">That code isn&rsquo;t valid for this order.</p>}

          <div className="space-y-1 pt-1 text-xs">
            <div className="flex justify-between text-muted">
              <span>Subtotal</span>
              <span>{formatCents(subtotal)}</span>
            </div>
            {discount > 0 && (
              <div className="flex justify-between text-ok font-semibold">
                <span>Discount</span>
                <span>-{formatCents(discount)}</span>
              </div>
            )}
            <div className="flex justify-between text-muted">
              <span>Tax</span>
              <span>{formatCents(tax)}</span>
            </div>
            <div className="flex justify-between text-base font-black pt-1.5 border-t border-border mt-1.5">
              <span>Total</span>
              <span>{formatCents(total)}</span>
            </div>
          </div>

          {error && <p className="text-danger text-xs">{error}</p>}

          <button
            onClick={placeOrder}
            disabled={busy || count === 0}
            className="w-full rounded-full bg-primary text-primary-fg font-black py-3.5 text-sm disabled:opacity-50 active:scale-[0.99] transition-transform"
          >
            {busy ? 'Placing…' : `Proceed to Checkout · ${formatCents(total)}`}
          </button>
        </div>
      )}
      {variant === 'sheet' && empty && onClose && (
        <div className="shrink-0 p-4 border-t border-border">
          <button onClick={onClose} className="w-full rounded-full border border-border font-bold py-3 text-sm">
            Back to menu
          </button>
        </div>
      )}
    </div>
  );
}
