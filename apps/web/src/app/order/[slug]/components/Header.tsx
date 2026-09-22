'use client';

import { Search, X } from 'lucide-react';

export function Header({
  restaurantName,
  logoUrl,
  tagline,
  guestName,
  tableLabel,
  searchQuery,
  onSearchChange,
}: {
  restaurantName: string;
  logoUrl: string | null;
  tagline: string | null;
  guestName: string;
  tableLabel: string;
  searchQuery: string;
  onSearchChange: (v: string) => void;
}) {
  return (
    <header className="px-4 pt-5 pb-3 border-b border-border">
      <div className="flex items-center gap-3">
        {logoUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={logoUrl} alt={`${restaurantName} logo`} className="h-11 w-11 rounded-xl object-contain bg-surface border border-border shrink-0" />
        ) : null}
        <div className="min-w-0 flex-1">
          <h1 className="font-black text-lg leading-tight truncate">{restaurantName}</h1>
          {tagline && <p className="text-muted text-[11.5px] truncate">{tagline}</p>}
        </div>
        <div className="text-right shrink-0">
          <div className="text-[10px] uppercase tracking-wide text-muted font-bold">
            {tableLabel ? `Table ${tableLabel}` : 'Ordering'}
          </div>
          <div className="text-xs font-semibold truncate max-w-[8rem]">{guestName}</div>
        </div>
      </div>

      <div className="relative mt-3.5">
        <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
        <input
          value={searchQuery}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder="Search chicken, burgers, fries…"
          className="w-full rounded-full border border-border bg-surface pl-9 pr-9 py-2.5 text-sm outline-none focus:border-primary transition-colors"
        />
        {searchQuery && (
          <button
            onClick={() => onSearchChange('')}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-muted hover:text-body"
            aria-label="Clear search"
          >
            <X size={15} />
          </button>
        )}
      </div>
    </header>
  );
}
