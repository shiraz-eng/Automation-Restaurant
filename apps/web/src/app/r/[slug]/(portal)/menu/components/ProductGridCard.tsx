'use client';

import { formatCents } from '@/lib/format';
import { itemAvailabilityStatus, minPriceCents, type Item, type ProductAvailabilityRow } from '../menuTypes';
import { ImageFallback } from './ImageFallback';
import { StatusPill } from './StatusPill';

export function ProductGridCard({
  item,
  availabilityRows,
  onEdit,
}: {
  item: Item;
  availabilityRows: ProductAvailabilityRow[];
  onEdit: () => void;
}) {
  const status = itemAvailabilityStatus(item, availabilityRows);
  const hasChoices = item.menu_variants.length > 1;
  const price = minPriceCents(item);

  return (
    <button
      onClick={onEdit}
      className="text-left rounded-lg border border-border bg-surface overflow-hidden hover:border-primary/40 transition-colors"
    >
      <div className="aspect-[4/3]">
        {item.image_url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={item.image_url} alt="" className="w-full h-full object-cover" />
        ) : (
          <ImageFallback className="w-full h-full" />
        )}
      </div>
      <div className="p-3">
        <div className="font-bold text-sm truncate">{item.name}</div>
        {item.description && <p className="text-muted text-[11px] truncate mt-0.5">{item.description}</p>}
        <div className="flex items-center justify-between mt-2">
          <span className="font-mono font-semibold text-sm">{hasChoices ? `from ${formatCents(price)}` : formatCents(price)}</span>
          <StatusPill status={status} />
        </div>
      </div>
    </button>
  );
}
