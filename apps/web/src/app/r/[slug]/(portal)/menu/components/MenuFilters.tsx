'use client';

import { LayoutGrid, List, Search } from 'lucide-react';

export type SortKey = 'name' | 'price' | 'food_cost' | 'availability';

export function MenuFilters({
  search,
  onSearch,
  availability,
  onAvailability,
  dealFilter,
  onDealFilter,
  sort,
  onSort,
  view,
  onView,
  canViewCost,
}: {
  search: string;
  onSearch: (v: string) => void;
  availability: 'all' | 'available' | 'unavailable' | 'sold_out' | 'low_stock' | 'out_of_stock';
  onAvailability: (v: 'all' | 'available' | 'unavailable' | 'sold_out' | 'low_stock' | 'out_of_stock') => void;
  dealFilter: 'all' | 'in_deal' | 'not_in_deal';
  onDealFilter: (v: 'all' | 'in_deal' | 'not_in_deal') => void;
  sort: SortKey;
  onSort: (v: SortKey) => void;
  view: 'table' | 'grid';
  onView: (v: 'table' | 'grid') => void;
  canViewCost: boolean;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="relative flex-1 min-w-[200px]">
        <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted" />
        <input
          value={search}
          onChange={(e) => onSearch(e.target.value)}
          placeholder="Search menu..."
          className="w-full rounded-lg border border-border bg-surface pl-8 pr-3 py-2 text-xs outline-none focus:border-primary transition-colors"
        />
      </div>

      <select
        value={availability}
        onChange={(e) => onAvailability(e.target.value as typeof availability)}
        className="rounded-lg border border-border bg-surface px-2.5 py-2 text-xs outline-none focus:border-primary"
      >
        <option value="all">All availability</option>
        <option value="available">Available</option>
        <option value="low_stock">Low stock</option>
        <option value="out_of_stock">Out of stock</option>
        <option value="unavailable">Hidden</option>
        <option value="sold_out">Sold out</option>
      </select>

      <select
        value={dealFilter}
        onChange={(e) => onDealFilter(e.target.value as typeof dealFilter)}
        className="rounded-lg border border-border bg-surface px-2.5 py-2 text-xs outline-none focus:border-primary"
      >
        <option value="all">All products</option>
        <option value="in_deal">In an active deal</option>
        <option value="not_in_deal">Not in a deal</option>
      </select>

      <select
        value={sort}
        onChange={(e) => onSort(e.target.value as SortKey)}
        className="rounded-lg border border-border bg-surface px-2.5 py-2 text-xs outline-none focus:border-primary"
      >
        <option value="name">Sort: Name</option>
        <option value="price">Sort: Price</option>
        {canViewCost && <option value="food_cost">Sort: Food cost %</option>}
        <option value="availability">Sort: Availability</option>
      </select>

      <div className="flex items-center rounded-lg border border-border overflow-hidden shrink-0">
        <button
          onClick={() => onView('table')}
          aria-label="Table view"
          className={`p-2 ${view === 'table' ? 'bg-primary text-primary-fg' : 'bg-surface text-muted hover:text-body'}`}
        >
          <List size={14} />
        </button>
        <button
          onClick={() => onView('grid')}
          aria-label="Grid view"
          className={`p-2 ${view === 'grid' ? 'bg-primary text-primary-fg' : 'bg-surface text-muted hover:text-body'}`}
        >
          <LayoutGrid size={14} />
        </button>
      </div>
    </div>
  );
}
