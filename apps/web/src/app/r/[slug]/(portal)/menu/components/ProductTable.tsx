'use client';

import { formatCents } from '@/lib/format';
import {
  computedStatusForItem,
  dealsForItem,
  itemAvailabilityStatus,
  minPriceCents,
  modifierOptionCount,
  recipeFoodCost,
  recipeForItem,
  type Category,
  type DealRow,
  type Item,
  type ProductAvailabilityRow,
  type RecipeRow,
} from '../menuTypes';
import { ImageFallback } from './ImageFallback';
import { StatusPill } from './StatusPill';

export function ProductTable({
  items,
  categories,
  deals,
  recipes,
  availabilityRows,
  canViewCost,
  onEdit,
}: {
  items: Item[];
  categories: Category[];
  deals: DealRow[];
  recipes: RecipeRow[];
  availabilityRows: ProductAvailabilityRow[];
  canViewCost: boolean;
  onEdit: (item: Item) => void;
}) {
  const categoryName = (id: string | null) => categories.find((c) => c.id === id)?.name ?? '—';

  return (
    <div className="rounded-lg border border-border bg-surface overflow-hidden">
      <div className="overflow-x-auto">
      <table className="w-full text-left text-xs border-collapse">
        <thead>
          <tr className="border-b border-border text-muted">
            <th className="p-3 font-semibold">Product</th>
            <th className="p-3 font-semibold hidden md:table-cell">Category</th>
            <th className="p-3 font-semibold text-right">Price</th>
            <th className="p-3 font-semibold">Availability</th>
            <th className="p-3 font-semibold hidden lg:table-cell">Modifiers</th>
            <th className="p-3 font-semibold hidden xl:table-cell">Recipe</th>
            {canViewCost && <th className="p-3 font-semibold text-right hidden xl:table-cell">Food Cost</th>}
            <th className="p-3 font-semibold hidden lg:table-cell">Deal</th>
            <th className="p-3" />
          </tr>
        </thead>
        <tbody>
          {items.map((it) => {
            const status = itemAvailabilityStatus(it, availabilityRows);
            const computed = computedStatusForItem(availabilityRows, it.id);
            const hasChoices = it.menu_variants.length > 1;
            const modCount = modifierOptionCount(it);
            const recipe = recipeForItem(recipes, it.id);
            const price = minPriceCents(it);
            const cost = recipe ? recipeFoodCost(recipe, price) : null;
            const linkedDeals = dealsForItem(deals, it.id);

            return (
              <tr
                key={it.id}
                onClick={() => onEdit(it)}
                className="border-b border-border/60 last:border-0 hover:bg-main/50 cursor-pointer transition-colors"
              >
                <td className="p-3">
                  <div className="flex items-center gap-3 min-w-0">
                    <div className="w-11 h-11 rounded-md overflow-hidden shrink-0 border border-border">
                      {it.image_url ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={it.image_url} alt="" className="w-full h-full object-cover" />
                      ) : (
                        <ImageFallback className="w-full h-full" />
                      )}
                    </div>
                    <div className="min-w-0">
                      <div className="font-bold text-sm truncate">{it.name}</div>
                      {it.description ? (
                        <div className="text-muted text-[11px] truncate max-w-[220px]">{it.description}</div>
                      ) : (
                        <div className="text-muted/60 text-[11px] italic">No description</div>
                      )}
                    </div>
                  </div>
                </td>
                <td className="p-3 hidden md:table-cell text-muted">{categoryName(it.category_id)}</td>
                <td className="p-3 text-right font-mono font-semibold whitespace-nowrap">
                  {hasChoices ? `from ${formatCents(price)}` : formatCents(price)}
                </td>
                <td className="p-3">
                  <StatusPill status={status} />
                  {(status === 'low_stock' || status === 'out_of_stock') && computed?.reason && (
                    <div className="text-muted text-[10px] mt-1 max-w-[140px] truncate" title={computed.reason}>
                      {computed.reason}
                    </div>
                  )}
                </td>
                <td className="p-3 hidden lg:table-cell text-muted">
                  {modCount > 0 ? `${modCount} Modifier${modCount === 1 ? '' : 's'}` : '—'}
                </td>
                <td className="p-3 hidden xl:table-cell">
                  {recipe ? <span className="text-ok font-semibold">Linked</span> : <span className="text-muted">None</span>}
                </td>
                {canViewCost && (
                  <td className="p-3 text-right hidden xl:table-cell font-mono">
                    {cost?.foodCostPct != null ? (
                      <span className={cost.foodCostPct > 35 ? 'text-warn font-semibold' : 'text-body'}>
                        {cost.foodCostPct}%
                      </span>
                    ) : (
                      <span className="text-muted">—</span>
                    )}
                  </td>
                )}
                <td className="p-3 hidden lg:table-cell">
                  {linkedDeals.length > 0 ? (
                    <span className="text-primary font-semibold truncate block max-w-[120px]">{linkedDeals[0].deal.name}</span>
                  ) : (
                    <span className="text-muted">—</span>
                  )}
                </td>
                <td className="p-3 text-right">
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onEdit(it);
                    }}
                    className="text-primary font-bold text-xs hover:underline"
                  >
                    Edit
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      </div>
      {items.length === 0 && <p className="text-muted text-xs p-6 text-center">No products match these filters.</p>}
    </div>
  );
}
