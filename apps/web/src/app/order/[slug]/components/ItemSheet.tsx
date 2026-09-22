'use client';

import { useState } from 'react';
import { X } from 'lucide-react';
import { formatCents } from '@/lib/format';
import type { BrowseItem, DealLite, ModGroup, ModOption, Product } from '../menuTypes';
import { ImageFallback } from './ImageFallback';

/**
 * Product-detail / customization step — shown whenever an item has more
 * than one variant, or any modifier group, so a plain single-variant item
 * with no modifiers never gets an unnecessary extra tap. Size/variant is
 * presented exactly like a required modifier group — one consistent picker
 * pattern rather than two different UI idioms. Displayed price is
 * provisional; the server always re-prices and re-validates every option
 * (and the variant itself) on submit.
 */
export function ItemSheet({
  item,
  relatedItems,
  relatedDeals,
  onClose,
  onAdd,
  onPickRelated,
  onPickDeal,
}: {
  item: BrowseItem;
  relatedItems: BrowseItem[];
  relatedDeals: DealLite[];
  onClose: () => void;
  onAdd: (item: Product, modifierIds: string[], snapshot: ModOption[]) => void;
  onPickRelated: (item: BrowseItem) => void;
  onPickDeal: (deal: DealLite) => void;
}) {
  const [variantId, setVariantId] = useState(
    (item.variants.find((v) => v.computed_available !== false) ?? item.variants[0])?.id ?? '',
  );
  const [selected, setSelected] = useState<Record<string, string[]>>({}); // group id -> option ids
  const [qty, setQty] = useState(1);

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
  const variantUnavailable = variant?.computed_available === false;

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
    for (let i = 0; i < qty; i++) onAdd(product, chosenIds, chosenOptions);
  }

  const unitTotal = (variant?.price_cents ?? 0) + addonTotal;

  return (
    <div className="fixed inset-0 z-40 bg-black/50 flex items-end sm:items-center sm:justify-center" onClick={onClose}>
      <div
        className="w-full sm:max-w-md bg-surface rounded-t-2xl sm:rounded-2xl max-h-[92vh] sm:max-h-[85vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="relative w-full aspect-[16/10] shrink-0">
          {item.image_url ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={item.image_url} alt={item.name} className="w-full h-full object-cover sm:rounded-t-2xl" />
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
          <h2 className="font-black text-lg leading-tight">{item.name}</h2>
          <p className="text-primary font-black text-base mt-1">{formatCents(variant?.price_cents ?? item.minPriceCents)}</p>
          {item.description && <p className="text-muted text-xs leading-relaxed mt-2">{item.description}</p>}

          <div className="space-y-5 mt-5">
            {item.variants.length > 1 && (
              <div>
                <div className="flex items-baseline justify-between mb-2">
                  <h3 className="font-bold text-sm">Choose size</h3>
                  <span className="text-[10.5px] font-bold uppercase tracking-wide text-primary">Required</span>
                </div>
                <div className="space-y-1.5">
                  {item.variants.map((v) => {
                    const checked = v.id === variantId;
                    const disabled = v.computed_available === false;
                    return (
                      <button
                        key={v.id}
                        onClick={() => !disabled && setVariantId(v.id)}
                        disabled={disabled}
                        className={`w-full flex items-center justify-between rounded-xl border px-3.5 py-2.5 text-sm text-left transition-colors ${
                          disabled ? 'border-border opacity-50 cursor-not-allowed' : checked ? 'border-primary bg-primary/5' : 'border-border'
                        }`}
                      >
                        <span className="flex items-center gap-2.5">
                          <span
                            className={`w-4 h-4 grid place-items-center rounded-full border-2 ${
                              checked && !disabled ? 'bg-primary border-primary text-primary-fg' : 'border-border'
                            }`}
                          >
                            {checked && !disabled ? '✓' : ''}
                          </span>
                          {v.name}
                        </span>
                        <span className="text-muted text-xs font-semibold">
                          {disabled ? 'Unavailable' : formatCents(v.price_cents)}
                        </span>
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
                  <span
                    className={`text-[10.5px] font-bold uppercase tracking-wide ${
                      g.kind === 'required_single' ? 'text-primary' : 'text-muted'
                    }`}
                  >
                    {g.kind === 'required_single'
                      ? 'Required'
                      : g.kind === 'multi' && g.max_select
                        ? `Choose up to ${g.max_select}`
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
                        className={`w-full flex items-center justify-between rounded-xl border px-3.5 py-2.5 text-sm text-left transition-colors ${
                          checked ? 'border-primary bg-primary/5' : 'border-border'
                        }`}
                      >
                        <span className="flex items-center gap-2.5">
                          <span
                            className={`w-4 h-4 grid place-items-center border-2 ${g.kind === 'multi' ? 'rounded-[5px]' : 'rounded-full'} ${
                              checked ? 'bg-primary border-primary text-primary-fg' : 'border-border'
                            }`}
                          >
                            {checked ? '✓' : ''}
                          </span>
                          {o.name}
                        </span>
                        <span className="text-muted text-xs font-semibold">
                          {o.price_cents > 0 ? `+${formatCents(o.price_cents)}` : 'Free'}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>

          {relatedDeals.length > 0 && (
            <div className="mt-6 pt-5 border-t border-border">
              <h3 className="font-bold text-sm mb-2">Make it a meal</h3>
              <div className="space-y-1.5">
                {relatedDeals.map((d) => (
                  <button
                    key={d.id}
                    onClick={() => onPickDeal(d)}
                    className="w-full flex items-center justify-between rounded-xl border border-primary/30 bg-primary/5 px-3.5 py-2.5 text-left"
                  >
                    <span className="text-sm font-semibold">{d.name}</span>
                    <span className="text-primary text-xs font-black shrink-0 ml-2">{formatCents(d.price_cents)}</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {relatedItems.length > 0 && (
            <div className="mt-6 pt-5 border-t border-border">
              <h3 className="font-bold text-sm mb-2.5">You may also like</h3>
              <div className="flex gap-2.5 overflow-x-auto no-scrollbar -mx-5 px-5 pb-1">
                {relatedItems.map((r) => (
                  <button
                    key={r.id}
                    onClick={() => onPickRelated(r)}
                    className="shrink-0 w-28 text-left rounded-xl border border-border overflow-hidden hover:border-primary/40 transition-colors"
                  >
                    <div className="w-28 h-20">
                      {r.image_url ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={r.image_url} alt={r.name} className="w-full h-full object-cover" />
                      ) : (
                        <ImageFallback className="w-full h-full" />
                      )}
                    </div>
                    <div className="p-1.5">
                      <div className="text-[11px] font-bold leading-tight line-clamp-2">{r.name}</div>
                      <div className="text-[10.5px] text-primary font-bold mt-0.5">{formatCents(r.minPriceCents)}</div>
                    </div>
                  </button>
                ))}
              </div>
            </div>
          )}
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
            disabled={requiredUnmet || !variant || variantUnavailable}
            className="flex-1 rounded-full bg-primary text-primary-fg font-black py-3.5 text-sm disabled:opacity-50 active:scale-[0.99] transition-transform"
          >
            {variantUnavailable ? 'Currently unavailable' : `Add to cart · ${formatCents(unitTotal * qty)}`}
          </button>
        </div>
      </div>
    </div>
  );
}
