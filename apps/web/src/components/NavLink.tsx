'use client';

import { useEffect, useRef } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

export function NavLink({
  href,
  exact,
  alsoActive,
  revealWhenActive,
  children,
}: {
  href: string;
  exact?: boolean;
  /** Other paths (and their sub-paths) that belong to this entry, e.g. a module's screens outside its own segment. */
  alsoActive?: string[];
  /** In a horizontally scrolling bar: scroll the active entry into view. */
  revealWhenActive?: boolean;
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const ref = useRef<HTMLAnchorElement>(null);
  const under = (p: string) => pathname === p || pathname.startsWith(`${p}/`);
  const active = exact ? pathname === href : under(href) || (alsoActive ?? []).some(under);

  useEffect(() => {
    if (revealWhenActive && active) ref.current?.scrollIntoView({ block: 'nearest', inline: 'center' });
  }, [revealWhenActive, active]);

  return (
    <Link
      ref={ref}
      href={href}
      aria-current={active ? 'page' : undefined}
      className={`px-3 py-2 rounded font-semibold ${
        active ? 'bg-primary/10 text-primary' : 'text-muted hover:bg-main hover:text-body'
      }`}
    >
      {children}
    </Link>
  );
}
