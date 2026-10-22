'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

export function NavLink({
  href,
  exact,
  alsoActive,
  children,
}: {
  href: string;
  exact?: boolean;
  /** Other paths (and their sub-paths) that belong to this entry, e.g. a module's screens outside its own segment. */
  alsoActive?: string[];
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const under = (p: string) => pathname === p || pathname.startsWith(`${p}/`);
  const active = exact ? pathname === href : under(href) || (alsoActive ?? []).some(under);

  return (
    <Link
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
