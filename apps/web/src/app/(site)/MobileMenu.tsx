'use client';

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Menu, X } from 'lucide-react';

export function MobileMenu({ items }: { items: [string, string][] }) {
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const pathname = usePathname();

  useEffect(() => setMounted(true), []);
  useEffect(() => setOpen(false), [pathname]);

  // While open: the page behind does not scroll, and Escape closes the menu.
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className="md:hidden">
      <button
        type="button"
        aria-label={open ? 'Close menu' : 'Open menu'}
        aria-expanded={open}
        aria-controls="site-mobile-menu"
        onClick={() => setOpen((v) => !v)}
        className="grid h-9 w-9 place-items-center rounded-lg border border-white/15 text-ink-fg"
      >
        {open ? <X size={18} /> : <Menu size={18} />}
      </button>

      {/* Rendered outside the header: its backdrop blur would otherwise make it the
          containing block of this fixed panel and squeeze the panel to the header's height. */}
      {open && mounted &&
        createPortal(
          <div
            id="site-mobile-menu"
            className="fixed inset-x-0 bottom-0 top-16 z-[55] overflow-y-auto bg-ink text-ink-fg site-fade-in md:hidden"
          >
            <nav aria-label="Mobile" className="mx-auto flex max-w-6xl flex-col gap-1 px-5 py-6">
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
          </div>,
          document.getElementById('site-root') ?? document.body,
        )}
    </div>
  );
}
