'use client';

import { Minus, Plus, Sparkles } from 'lucide-react';
import { formatCents } from '@/lib/format';
import { dealIndividualTotalCents, refName, type DealLite } from '../menuTypes';
import { ImageFallback } from './ImageFallback';

export function DealCard({
  deal,
  qty,
  onOpenSheet,
  onBump,
}: {
  deal: DealLite;
  qty: number;
  onOpenSheet: () => void;
  onBump: (delta: number) => void;
}) {
  const hasOptions = (deal.deal_option_groups?.length ?? 0) > 0;
  const individual = dealIndividualTotalCents(deal);
  const savings = individual - deal.price_cents;
  const componentSummary = hasOptions
    ? deal.deal_option_groups!.map((g) => g.name).join(' + ')
    : deal.deal_components.map((c) => `${c.qty}× ${refName(c.menu_variants) || refName(c.menu_items)}`).join(' + ');

  return (
    <div className="group rounded-xl border border-primary/25 bg-gradient-to-br from-primary/[0.06] to-transparent overflow-hidden flex flex-col hover:border-primary/50 transition-colors">
      <button type="button" onClick={onOpenSheet} className="relative block w-full aspect-[16/9] overflow-hidden text-left">
        {deal.image_url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={deal.image_url}
            alt={deal.name}
            className="w-full h-full object-cover group-hover:scale-[1.03] transition-transform duration-300"
            loading="lazy"
            onError={(e) => {
              e.currentTarget.style.display = 'none';
            }}
          />
        ) : (
          <ImageFallback className="w-full h-full" />
        )}
        <span className="absolute top-2 left-2 inline-flex items-center gap-1 rounded-full bg-primary text-primary-fg text-[10px] font-black uppercase tracking-wide px-2 py-1">
          <Sparkles size={11} /> Deal
        </span>
        {savings > 0 && (
          <span className="absolute top-2 right-2 rounded-full bg-ok text-white text-[10px] font-black px-2 py-1">
            Save {formatCents(savings)}
          </span>
        )}
      </button>

      <div className="p-3 flex flex-col flex-1">
        <div className="font-bold text-sm leading-snug">{deal.name}</div>
        <p className="text-muted text-[11.5px] leading-snug mt-0.5 line-clamp-2">{componentSummary}</p>

        <div className="flex items-center justify-between gap-2 mt-2.5">
          <span className="flex items-baseline gap-1.5">
            <span className="font-black text-sm text-primary">
              {hasOptions ? `from ${formatCents(deal.price_cents)}` : formatCents(deal.price_cents)}
            </span>
            {!hasOptions && savings > 0 && (
              <span className="text-muted text-[11px] line-through">{formatCents(individual)}</span>
            )}
          </span>

          {hasOptions ? (
            <button
              onClick={onOpenSheet}
              className="rounded-full bg-primary text-primary-fg font-bold px-3.5 py-1.5 text-xs shrink-0 active:scale-95 transition-transform"
            >
              Choose
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
