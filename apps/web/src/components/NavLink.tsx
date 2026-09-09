'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

export function NavLink({
  href,
  exact,
  children,
}: {
  href: string;
  exact?: boolean;
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const active = exact ? pathname === href : pathname === href || pathname.startsWith(`${href}/`);

  return (
    <Link
      href={href}
      className={`px-3 py-2 rounded font-semibold ${
        active ? 'bg-primary/10 text-primary' : 'text-muted hover:bg-main hover:text-body'
      }`}
    >
      {children}
    </Link>
  );
}
