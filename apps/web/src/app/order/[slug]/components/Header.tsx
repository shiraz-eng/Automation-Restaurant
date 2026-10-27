'use client';

import { Search, X } from 'lucide-react';
import { AccessibilityMenu } from '@/components/AccessibilityMenu';

export function Header({
  restaurantName,
  logoUrl,
  tagline,
  guestName,
  tableLabel,
  searchQuery,
  onSearchChange,
  onEditGuest,
}: {
  restaurantName: string;
  logoUrl: string | null;
  tagline: string | null;
  guestName: string;
  tableLabel: string;
  searchQuery: string;
  onSearchChange: (v: string) => void;
  onEditGuest?: () => void;
}) {
  const tableDisplay = tableLabel
    ? tableLabel.toLowerCase().startsWith('table')
      ? tableLabel
      : `Table ${tableLabel}`
    : 'Ordering';

  return (
    <header className="px-4 pt-5 pb-3 border-b border-border">
      <div className="flex items-center gap-3">
        {logoUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={logoUrl} alt={`${restaurantName} logo`} className="h-11 w-11 rounded-xl object-contain bg-surface border border-border shrink-0" />
        ) : null}
        <div className="min-w-0 flex-1">
          <h1 className="font-black text-lg leading-tight truncate">{restaurantName}</h1>
          {tagline && <p className="text-muted text-[0.71875rem] truncate">{tagline}</p>}
        </div>
        <button
          type="button"
          onClick={onEditGuest}
          className="text-end shrink-0 rounded-lg p-1 hover:bg-surface/80 transition-colors text-start"
          title="Click to edit table or name"
          aria-label={`${tableDisplay}, ordering as ${guestName}. Change table or name`}
        >
          <div className="text-[0.625rem] uppercase tracking-wide text-muted font-bold">
            {tableDisplay}
          </div>
          <div className="text-xs font-semibold truncate max-w-[8rem]">{guestName}</div>
        </button>
        <AccessibilityMenu className="shrink-0" />
      </div>

      <div className="relative mt-3.5" role="search">
        <Search size={15} className="absolute start-3 top-1/2 -translate-y-1/2 text-muted" aria-hidden />
        <input
          type="search"
          aria-label="Search the menu"
          value={searchQuery}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder="Search chicken, burgers, fries…"
          className="w-full rounded-full border border-border bg-surface ps-9 pe-9 py-2.5 text-sm outline-none focus:border-primary transition-colors"
        />
        {searchQuery && (
          <button
            onClick={() => onSearchChange('')}
            className="absolute end-3 top-1/2 -translate-y-1/2 text-muted hover:text-body"
            aria-label="Clear search"
          >
            <X size={15} />
          </button>
        )}
      </div>
    </header>
  );
}
