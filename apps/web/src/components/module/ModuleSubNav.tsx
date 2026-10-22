'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

export type SubNavItem = { key: string; title: string; href: string; shared: boolean };

/**
 * A module's sub-navigation bar (Finance): a slim row of links above the
 * page, shown on the module's own screens with the current one highlighted.
 *
 * Some entries open a screen another module owns (Payables lives under
 * Suppliers, Audit log under Analytics). The bar stays visible there only
 * when it was the way the user got there, so those screens opened from the
 * main sidebar look exactly as before. That "came from the bar" note is kept
 * per tab (sessionStorage) and dropped once the user leaves the bar's screens.
 *
 * `items` are already filtered by the viewer's permissions on the server.
 */
export function ModuleSubNav({
  slug,
  label,
  ownedPaths,
  items,
}: {
  slug: string;
  label: string;
  /** The module's own screens (and the landing): the bar always shows on these. */
  ownedPaths: string[];
  items: SubNavItem[];
}) {
  const pathname = usePathname();
  const storageKey = `subnav:${slug}:${label}`;
  const [via, setVia] = useState<string | null>(null);
  const activeRef = useRef<HTMLAnchorElement>(null);

  const under = (p: string) => (p === `/r/${slug}` ? pathname === p : pathname === p || pathname.startsWith(`${p}/`));
  const owned = ownedPaths.some(under);
  const sharedHere = items.find((i) => i.shared && under(i.href));

  const remember = (href: string | null) => {
    setVia(href);
    try {
      if (href) sessionStorage.setItem(storageKey, href);
      else sessionStorage.removeItem(storageKey);
    } catch {
      /* ignore */
    }
  };

  // Restore "came from the bar" after a reload.
  useEffect(() => {
    try {
      setVia(sessionStorage.getItem(storageKey));
    } catch {
      /* storage blocked: the bar simply shows on the module's own screens */
    }
  }, [storageKey]);

  // Leaving the bar's screens forgets how the user arrived.
  useEffect(() => {
    if (!owned && !sharedHere && via) remember(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname]);

  const visible = owned || Boolean(sharedHere && via === sharedHere.href);

  // The longest matching entry is the current page (Performance, the dashboard, only on an exact match).
  const active = visible
    ? items.filter((i) => under(i.href)).sort((a, b) => b.href.length - a.href.length)[0]?.key ?? null
    : null;

  useEffect(() => {
    if (visible) activeRef.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [visible, active]);

  if (!visible || items.length === 0) return null;

  return (
    <nav aria-label={`${label} sections`} className="border-b border-border bg-surface/70">
      <div className="flex items-center gap-3 overflow-x-auto no-scrollbar px-4 sm:px-6 md:px-10">
        <span className="shrink-0 py-2.5 text-[10px] font-bold uppercase tracking-wider text-muted/80">{label}</span>
        <span aria-hidden className="h-4 w-px shrink-0 bg-border" />
        <ul className="flex items-stretch">
          {items.map((item, i) => {
            const isActive = item.key === active;
            return (
              <li key={item.key} className="flex items-center">
                {i > 0 && <span aria-hidden className="h-3 w-px bg-border/80" />}
                <Link
                  ref={isActive ? activeRef : undefined}
                  href={item.href}
                  aria-current={isActive ? 'page' : undefined}
                  onClick={() => remember(item.shared ? item.href : null)}
                  className={`relative block whitespace-nowrap px-3 py-2.5 text-[13px] transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-body ${
                    isActive
                      ? 'font-semibold text-body after:absolute after:inset-x-3 after:bottom-0 after:h-0.5 after:rounded-full after:bg-primary'
                      : 'text-muted hover:text-body'
                  }`}
                >
                  {item.title}
                </Link>
              </li>
            );
          })}
        </ul>
      </div>
    </nav>
  );
}
