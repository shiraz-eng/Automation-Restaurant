'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

export type SubNavItem = { key: string; title: string; href: string };
export type SubNav = {
  key: string;
  label: string;
  /** The module's landing page: the bar's label links back to it. */
  landing: string;
  /** The module's own screens (and the landing). */
  ownedPaths: string[];
  /** Already filtered by the viewer's permissions on the server. */
  items: SubNavItem[];
};

type Via = { nav: string; href: string };

/**
 * The module sub-navigation bar: a slim row of links above the page with the
 * current screen highlighted. One bar shows at a time:
 *
 *  1. the bar the user just used, when it opened a screen another module owns
 *     (Finance → Audit log keeps the Finance bar), remembered per tab so a
 *     reload keeps it;
 *  2. otherwise the bar of the module that owns the screen (longest match);
 *  3. none on screens no module owns (the dashboard) unless (1) applies.
 *
 * Leaving the screen that (1) opened forgets it.
 */
export function ModuleSubNav({ slug, navs }: { slug: string; navs: SubNav[] }) {
  const pathname = usePathname();
  const storageKey = `subnav:${slug}`;
  const [via, setVia] = useState<Via | null>(null);
  const activeRef = useRef<HTMLAnchorElement>(null);

  const under = (p: string) => (p === `/r/${slug}` ? pathname === p : pathname === p || pathname.startsWith(`${p}/`));

  const remember = (v: Via | null) => {
    setVia(v);
    try {
      if (v) sessionStorage.setItem(storageKey, JSON.stringify(v));
      else sessionStorage.removeItem(storageKey);
    } catch {
      /* storage blocked: bars still follow the screen's own module */
    }
  };

  // Restore (1) after a reload.
  useEffect(() => {
    try {
      const raw = sessionStorage.getItem(storageKey);
      if (raw) setVia(JSON.parse(raw) as Via);
    } catch {
      /* ignore */
    }
  }, [storageKey]);

  // Leaving the screen the bar opened forgets how the user got there.
  useEffect(() => {
    if (via && !under(via.href)) remember(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname]);

  const owner = (() => {
    let best: { nav: SubNav; len: number } | null = null;
    for (const nav of navs) {
      for (const p of nav.ownedPaths) {
        if (under(p) && (!best || p.length > best.len)) best = { nav, len: p.length };
      }
    }
    return best?.nav ?? null;
  })();
  const viaNav = via && under(via.href) ? navs.find((n) => n.key === via.nav && n.items.some((i) => i.href === via.href)) : undefined;
  const nav = viaNav ?? owner;

  // The longest matching entry is the current screen (the dashboard only on an exact match).
  const active = nav ? nav.items.filter((i) => under(i.href)).sort((a, b) => b.href.length - a.href.length)[0]?.key ?? null : null;

  useEffect(() => {
    if (nav) activeRef.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [nav, active]);

  if (!nav) return null;

  return (
    <nav aria-label={`${nav.label} sections`} className="border-b border-border bg-surface/70">
      <div className="flex items-center gap-3 overflow-x-auto no-scrollbar px-4 sm:px-6 md:px-10">
        <Link
          href={nav.landing}
          onClick={() => remember(null)}
          className="shrink-0 py-2.5 text-[10px] font-bold uppercase tracking-wider text-muted/80 hover:text-body focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-body"
        >
          {nav.label}
        </Link>
        <span aria-hidden className="h-4 w-px shrink-0 bg-border" />
        <ul className="flex items-stretch">
          {nav.items.map((item, i) => {
            const isActive = item.key === active;
            // A screen another module owns: keep this bar there.
            const foreign = !nav.ownedPaths.some((p) => item.href === p || item.href.startsWith(`${p}/`));
            return (
              <li key={item.key} className="flex items-center">
                {i > 0 && <span aria-hidden className="h-3 w-px bg-border/80" />}
                <Link
                  ref={isActive ? activeRef : undefined}
                  href={item.href}
                  aria-current={isActive ? 'page' : undefined}
                  onClick={() => remember(foreign ? { nav: nav.key, href: item.href } : null)}
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
