'use client';

import { useState } from 'react';
import { X } from 'lucide-react';
import { formatCents } from '@/lib/format';
import type { DealLite, DealOptionGroup, DealOptionItem } from '../menuTypes';
import { dealOptionLabel } from '../menuTypes';
import { ImageFallback } from './ImageFallback';

/**
 * Build-Your-Own-Combo sheet — one consistent picker per option group, same
 * idiom as ItemSheet's modifier groups: a max-1 group behaves like a
 * required radio choice, anything wider is a capped multi-select.
 * Displayed price is provisional; place_order() always re-prices and
 * re-validates every selection on submit.
 */
export function DealSheet({
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
  const [qty, setQty] = useState(1);

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
  const unitTotal = deal.price_cents + addonTotal;

  function add() {
    for (let i = 0; i < qty; i++) onAdd(deal, chosenIds, chosenOptions);
  }

  return (
    <div className="fixed inset-0 z-40 bg-black/50 flex items-end sm:items-center sm:justify-center" onClick={onClose}>
      <div
        className="w-full sm:max-w-md bg-surface rounded-t-2xl sm:rounded-2xl max-h-[92vh] sm:max-h-[85vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="relative w-full aspect-[16/10] shrink-0">
          {deal.image_url ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={deal.image_url} alt={deal.name} className="w-full h-full object-cover sm:rounded-t-2xl" />
          ) : (
            <ImageFallback className="w-full h-full sm:rounded-t-2xl" />
          )}
          <button
            onClick={onClose}
            className="absolute top-3 right-3 w-8 h-8 rounded-full bg-black/50 text-white grid place-items-center backdrop-blur"
            aria-label="Close"
          >
            <X size={16} />
          </button>
        </div>

        <div className="p-5">
          <h2 className="font-black text-lg leading-tight">{deal.name}</h2>
          <p className="text-primary font-black text-base mt-1">{formatCents(deal.price_cents)}</p>
          {deal.description && <p className="text-muted text-xs leading-relaxed mt-2">{deal.description}</p>}

          <div className="space-y-5 mt-5">
            {groups.map((g) => (
              <div key={g.id}>
                <div className="flex items-baseline justify-between mb-2">
                  <h3 className="font-bold text-sm">{g.name}</h3>
                  <span
                    className={`text-[10.5px] font-bold uppercase tracking-wide ${
                      g.min_select > 0 ? 'text-primary' : 'text-muted'
                    }`}
                  >
                    {g.min_select > 0
                      ? 'Required'
                      : g.max_select && g.max_select > 1
                        ? `Choose up to ${g.max_select}`
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
                        className={`w-full flex items-center justify-between rounded-xl border px-3.5 py-2.5 text-sm text-left transition-colors ${
                          checked ? 'border-primary bg-primary/5' : 'border-border'
                        }`}
                      >
                        <span className="flex items-center gap-2.5">
                          <span
                            className={`w-4 h-4 grid place-items-center border-2 ${g.max_select === 1 ? 'rounded-full' : 'rounded-[5px]'} ${
                              checked ? 'bg-primary border-primary text-primary-fg' : 'border-border'
                            }`}
                          >
                            {checked ? '✓' : ''}
                          </span>
                          {dealOptionLabel(o)}
                        </span>
                        <span className="text-muted text-xs font-semibold">{addon > 0 ? `+${formatCents(addon)}` : 'Free'}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="sticky bottom-0 bg-surface border-t border-border p-4 flex items-center gap-3">
          <div className="flex items-center gap-2.5 rounded-full border border-border px-1 py-1 shrink-0">
            <button
              onClick={() => setQty((q) => Math.max(1, q - 1))}
              className="w-8 h-8 rounded-full grid place-items-center text-body active:scale-90 transition-transform"
              aria-label="Decrease quantity"
            >
              −
            </button>
            <span className="w-5 text-center text-sm font-black">{qty}</span>
            <button
              onClick={() => setQty((q) => q + 1)}
              className="w-8 h-8 rounded-full grid place-items-center text-body active:scale-90 transition-transform"
              aria-label="Increase quantity"
            >
              +
            </button>
          </div>
          <button
            onClick={add}
            disabled={requiredUnmet}
            className="flex-1 rounded-full bg-primary text-primary-fg font-black py-3.5 text-sm disabled:opacity-50 active:scale-[0.99] transition-transform"
          >
            Add to cart · {formatCents(unitTotal * qty)}
          </button>
        </div>
      </div>
    </div>
  );
}
