'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Menu, X } from 'lucide-react';

export function MobileMenu({ items }: { items: [string, string][] }) {
  const [open, setOpen] = useState(false);

  return (
    <div className="md:hidden">
      <button
        type="button"
        aria-label={open ? 'Close menu' : 'Open menu'}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="grid h-9 w-9 place-items-center rounded-lg border border-white/15 text-ink-fg"
      >
        {open ? <X size={18} /> : <Menu size={18} />}
      </button>

      {open && (
        <div className="fixed inset-0 top-16 z-30 bg-ink/98 backdrop-blur-sm site-fade-in">
          <nav className="mx-auto flex max-w-6xl flex-col gap-1 px-5 py-6">
            {items.map(([href, label]) => (
              <Link
                key={href}
                href={href}
                onClick={() => setOpen(false)}
                className="rounded-lg px-3 py-3 text-base font-semibold text-ink-fg hover:bg-white/5"
              >
                {label}
              </Link>
            ))}
            <div className="mt-4 flex flex-col gap-2.5 border-t border-white/10 pt-5">
              <Link
                href="/login"
                onClick={() => setOpen(false)}
                className="rounded-lg border border-white/15 px-4 py-3 text-center text-sm font-semibold text-ink-fg"
              >
                Sign in
              </Link>
              <Link
                href="/get-started"
                onClick={() => setOpen(false)}
                className="rounded-lg bg-black border border-white/15 px-4 py-3 text-center text-sm font-bold text-white"
              >
                Get Started
              </Link>
            </div>
          </nav>
        </div>
      )}
    </div>
  );
}
