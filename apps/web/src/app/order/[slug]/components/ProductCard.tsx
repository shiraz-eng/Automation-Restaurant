'use client';

import { Minus, Plus } from 'lucide-react';
import { formatCents } from '@/lib/format';
import type { BrowseItem, Product } from '../menuTypes';
import { ImageFallback } from './ImageFallback';

export function ProductCard({
  item,
  soleProduct,
  qty,
  onOpenSheet,
  onBump,
}: {
  item: BrowseItem;
  /** Set only when the item has exactly one variant and no modifier groups —
   *  i.e. nothing to configure, so the card can add/step it in place. */
  soleProduct?: Product;
  qty: number;
  onOpenSheet: () => void;
  onBump: (delta: number) => void;
}) {
  const hasChoices = item.variants.length > 1 || item.modifier_groups.length > 0;
  const unavailable = !item.computed_available;

  return (
    <div className={`group rounded-xl border border-border bg-surface overflow-hidden flex flex-col transition-colors ${unavailable ? 'opacity-60' : 'hover:border-primary/40 hover:shadow-sm'}`}>
      <button
        type="button"
        onClick={onOpenSheet}
        className="relative block w-full aspect-[4/3] overflow-hidden text-left"
        aria-label={`View ${item.name}`}
      >
        {item.image_url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={item.image_url}
            alt={item.name}
            className={`w-full h-full object-cover transition-transform duration-300 ${unavailable ? 'grayscale' : 'group-hover:scale-[1.03]'}`}
            loading="lazy"
            onError={(e) => {
              e.currentTarget.style.display = 'none';
              e.currentTarget.parentElement?.classList.add('fallback-active');
            }}
          />
        ) : (
          <ImageFallback className="w-full h-full" />
        )}
        {unavailable && (
          <span className="absolute top-2 left-2 rounded-full bg-black/70 text-white text-[10px] font-bold uppercase tracking-wide px-2 py-0.5">
            Unavailable
          </span>
        )}
      </button>

      <div className="p-3 flex flex-col flex-1">
        <button type="button" onClick={onOpenSheet} className="text-left flex-1">
          <div className="font-bold text-sm leading-snug line-clamp-1">{item.name}</div>
          {item.description && (
            <p className="text-muted text-[11.5px] leading-snug mt-0.5 line-clamp-2">{item.description}</p>
          )}
        </button>

        <div className="flex items-center justify-between gap-2 mt-2.5">
          <span className="font-black text-sm">
            {hasChoices ? `from ${formatCents(item.minPriceCents)}` : formatCents(item.minPriceCents)}
          </span>

          {unavailable ? (
            <span className="text-muted font-bold text-xs shrink-0">Unavailable</span>
          ) : hasChoices || !soleProduct ? (
            <button
              onClick={onOpenSheet}
              className="rounded-full bg-primary text-primary-fg font-bold px-3.5 py-1.5 text-xs shrink-0 active:scale-95 transition-transform"
            >
              Add
            </button>
          ) : qty === 0 ? (
            <button
              onClick={() => onBump(1)}
              className="rounded-full bg-primary text-primary-fg font-bold px-3.5 py-1.5 text-xs shrink-0 active:scale-95 transition-transform"
            >
              Add
            </button>
          ) : (
            <div className="flex items-center gap-2 shrink-0 rounded-full border border-primary/30 bg-primary/5 px-1 py-1">
              <button
                onClick={() => onBump(-1)}
                className="w-6 h-6 rounded-full grid place-items-center text-primary active:scale-90 transition-transform"
                aria-label="Remove one"
              >
                <Minus size={13} strokeWidth={2.5} />
              </button>
              <span className="w-4 text-center text-xs font-black">{qty}</span>
              <button
                onClick={() => onBump(1)}
                className="w-6 h-6 rounded-full grid place-items-center text-primary active:scale-90 transition-transform"
                aria-label="Add one more"
              >
                <Plus size={13} strokeWidth={2.5} />
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
