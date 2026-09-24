'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { usePortalSupabase } from '@/components/PortalProvider';
import {
  dealsForItem,
  itemAvailabilityStatus,
  minPriceCents,
  recipeFoodCost,
  recipeForItem,
  type Category,
  type DealRow,
  type Ingredient,
  type Item,
  type ProductAvailabilityRow,
  type RecipeRow,
} from './menuTypes';
import { MenuHeader } from './components/MenuHeader';
import { MenuSummary, type SummaryStat } from './components/MenuSummary';
import { MenuFilters, type SortKey } from './components/MenuFilters';
import { MenuCategoryNav } from './components/MenuCategoryNav';
import { ProductTable } from './components/ProductTable';
import { ProductGridCard } from './components/ProductGridCard';
import { ProductEditor } from './components/ProductEditor';
import { CreateProductModal } from './components/CreateProductModal';
import { CategoryManagerPanel } from './components/CategoryManagerPanel';

export function MenuManager({
  slug,
  categories,
  items,
  ingredients,
  deals,
  recipes,
  availabilityRows,
  canEdit,
  canCreate,
  canDelete,
  canViewCost,
  canManageRecipes = false,
}: {
  slug: string;
  categories: Category[];
  items: Item[];
  ingredients: Ingredient[];
  deals: DealRow[];
  recipes: RecipeRow[];
  availabilityRows: ProductAvailabilityRow[];
  canEdit: boolean;
  canCreate: boolean;
  canDelete: boolean;
  canViewCost: boolean;
  /** inventory.manage_recipes / finance.manage_recipes — lets product
   *  creation and the editor connect a recipe (the RPCs re-check it). */
  canManageRecipes?: boolean;
}) {
  const router = useRouter();
  const supabase = usePortalSupabase();

  // The recipe-driven availability engine (tenant-migrations/0052) writes to
  // product_availability the moment inventory changes — refresh the server
  // payload so this page reflects it without a manual reload, same realtime
  // pattern the Kitchen board already uses for orders/order_lines.
  useEffect(() => {
    const channel = supabase
      .channel(`menu-availability-${slug}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'product_availability' }, () => router.refresh())
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [supabase, slug, router]);

  const [search, setSearch] = useState('');
  const [activeCat, setActiveCat] = useState('all');
  const [availability, setAvailability] = useState<'all' | 'available' | 'unavailable' | 'sold_out' | 'low_stock' | 'out_of_stock'>('all');
  const [dealFilter, setDealFilter] = useState<'all' | 'in_deal' | 'not_in_deal'>('all');
  const [sort, setSort] = useState<SortKey>('name');
  const [view, setView] = useState<'table' | 'grid'>('table');

  const [editingId, setEditingId] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [showCategories, setShowCategories] = useState(false);

  const sortedCategories = useMemo(() => [...categories].sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0)), [categories]);

  // Filters that apply regardless of the active category pill — used both
  // for the visible list and for the category-pill counts, so the counts
  // shown always match what selecting that pill will actually reveal.
  const preCategoryFiltered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return items.filter((it) => {
      if (q && !it.name.toLowerCase().includes(q) && !(it.description ?? '').toLowerCase().includes(q)) return false;
      if (availability !== 'all' && itemAvailabilityStatus(it, availabilityRows) !== availability) return false;
      if (dealFilter !== 'all') {
        const inDeal = dealsForItem(deals, it.id).length > 0;
        if (dealFilter === 'in_deal' && !inDeal) return false;
        if (dealFilter === 'not_in_deal' && inDeal) return false;
      }
      return true;
    });
  }, [items, search, availability, dealFilter, deals, availabilityRows]);

  const categoryCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const it of preCategoryFiltered) counts[it.category_id ?? ''] = (counts[it.category_id ?? ''] ?? 0) + 1;
    return counts;
  }, [preCategoryFiltered]);

  const visibleItems = useMemo(() => {
    let out = preCategoryFiltered;
    if (activeCat === 'uncategorised') out = out.filter((it) => !it.category_id);
    else if (activeCat !== 'all') out = out.filter((it) => it.category_id === activeCat);

    const sorted = [...out].sort((a, b) => {
      switch (sort) {
        case 'price':
          return minPriceCents(a) - minPriceCents(b);
        case 'availability':
          return itemAvailabilityStatus(a, availabilityRows).localeCompare(itemAvailabilityStatus(b, availabilityRows));
        case 'food_cost': {
          const ra = recipeForItem(recipes, a.id);
          const rb = recipeForItem(recipes, b.id);
          const ca = ra ? (recipeFoodCost(ra, minPriceCents(a))?.foodCostPct ?? -1) : -1;
          const cb = rb ? (recipeFoodCost(rb, minPriceCents(b))?.foodCostPct ?? -1) : -1;
          return cb - ca;
        }
        default:
          return a.name.localeCompare(b.name);
      }
    });
    return sorted;
  }, [preCategoryFiltered, activeCat, sort, recipes, availabilityRows]);

  const summary: SummaryStat[] = useMemo(() => {
    const statuses = items.map((it) => itemAvailabilityStatus(it, availabilityRows));
    const available = statuses.filter((s) => s === 'available').length;
    const lowStock = statuses.filter((s) => s === 'low_stock').length;
    const outOfStock = statuses.filter((s) => s === 'out_of_stock').length;
    const hiddenOrSoldOut = items.length - available - lowStock - outOfStock;
    return [
      { label: 'Total Products', value: items.length },
      { label: 'Available', value: available, tone: 'ok' },
      { label: 'Low Stock', value: lowStock, tone: lowStock > 0 ? 'warn' : undefined },
      { label: 'Out of Stock', value: outOfStock, tone: outOfStock > 0 ? 'danger' : undefined },
      { label: 'Hidden / Sold Out', value: hiddenOrSoldOut },
      { label: 'Active Deals', value: deals.length, tone: 'primary' },
    ];
  }, [items, deals.length, availabilityRows]);

  const editingItem = editingId ? (items.find((it) => it.id === editingId) ?? null) : null;
  const allStations = useMemo(
    () => [...new Set(items.map((it) => it.station?.trim()).filter((s): s is string => !!s))].sort(),
    [items],
  );

  return (
    <div className="space-y-5">
      <MenuHeader canCreate={canCreate} onAddProduct={() => setShowCreate(true)} onManageCategories={() => setShowCategories(true)} />

      <MenuSummary stats={summary} />

      <MenuFilters
        search={search}
        onSearch={setSearch}
        availability={availability}
        onAvailability={setAvailability}
        dealFilter={dealFilter}
        onDealFilter={setDealFilter}
        sort={sort}
        onSort={setSort}
        view={view}
        onView={setView}
        canViewCost={canViewCost}
      />

      <MenuCategoryNav categories={sortedCategories} counts={categoryCounts} activeId={activeCat} onPick={setActiveCat} />

      {view === 'table' ? (
        <ProductTable
          items={visibleItems}
          categories={categories}
          deals={deals}
          recipes={recipes}
          availabilityRows={availabilityRows}
          canViewCost={canViewCost}
          onEdit={(it) => setEditingId(it.id)}
        />
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-4 gap-3">
          {visibleItems.map((it) => (
            <ProductGridCard key={it.id} item={it} availabilityRows={availabilityRows} onEdit={() => setEditingId(it.id)} />
          ))}
          {visibleItems.length === 0 && <p className="text-muted text-xs col-span-full text-center py-8">No products match these filters.</p>}
        </div>
      )}

      {editingItem && (
        <ProductEditor
          key={editingItem.id}
          slug={slug}
          item={editingItem}
          categories={categories}
          ingredients={ingredients}
          recipes={recipes}
          deals={deals}
          availabilityRows={availabilityRows}
          stations={allStations}
          canEdit={canEdit}
          canDelete={canDelete}
          canViewCost={canViewCost}
          canManageRecipes={canManageRecipes}
          onClose={() => setEditingId(null)}
          onDeleted={() => setEditingId(null)}
          onDuplicated={(newId) => setEditingId(newId)}
        />
      )}

      {showCreate && (
        <CreateProductModal
          categories={sortedCategories}
          recipes={recipes}
          canManageRecipes={canManageRecipes}
          onClose={() => setShowCreate(false)}
          onCreated={(id) => {
            setShowCreate(false);
            setEditingId(id);
          }}
        />
      )}

      {showCategories && <CategoryManagerPanel categories={categories} items={items} canEdit={canEdit} onClose={() => setShowCategories(false)} />}
    </div>
  );
}
