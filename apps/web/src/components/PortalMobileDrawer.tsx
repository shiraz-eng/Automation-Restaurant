'use client';

import { useEffect, useRef, useState } from 'react';
import { useDialogFocus } from '@/lib/useDialogFocus';
import { usePathname } from 'next/navigation';
import { Menu, X } from 'lucide-react';

/**
 * Phones and tablets (below 1024px, so POS and Kitchen get the full width): the portal sidebar (navigation, workspace
 * switcher, account and sign-out) in a slide-in drawer opened from the top bar.
 * The desktop sidebar renders the same content from the layout.
 */
export function PortalMobileDrawer({ title, children }: { title: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();
  const panelRef = useRef<HTMLElement>(null);
  // Focus moves into the drawer, Tab stays inside, Escape closes, focus returns to the Menu button.
  useDialogFocus(panelRef, open, () => setOpen(false));

  useEffect(() => setOpen(false), [pathname]);

  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  return (
    <div className="lg:hidden">
      <button
        type="button"
        aria-label="Open menu"
        aria-expanded={open}
        aria-controls="portal-drawer"
        onClick={() => setOpen(true)}
        className="grid h-9 w-9 place-items-center rounded-lg border border-border text-body hover:bg-main"
      >
        <Menu className="h-[18px] w-[18px]" aria-hidden />
      </button>

      {/* Kept mounted so the drawer's own state (e.g. an open password form) survives toggling. */}
      <div className={`fixed inset-0 z-[60] ${open ? '' : 'pointer-events-none'}`} aria-hidden={!open}>
        <div
          className={`absolute inset-0 bg-black/40 transition-opacity motion-reduce:transition-none ${open ? 'opacity-100' : 'opacity-0'}`}
          onClick={() => setOpen(false)}
        />
        <aside
          ref={panelRef}
          id="portal-drawer"
          role="dialog"
          aria-modal="true"
          aria-label={title}
          inert={!open}
          className={`absolute inset-y-0 start-0 flex w-[min(18rem,85vw)] flex-col overflow-y-auto border-e border-border bg-surface shadow-xl transition-transform motion-reduce:transition-none ${
            open ? 'translate-x-0' : '-translate-x-full rtl:translate-x-full'
          }`}
        >
          <button
            type="button"
            aria-label="Close menu"
            onClick={() => setOpen(false)}
            className="absolute end-3 top-3 grid h-8 w-8 place-items-center rounded-lg text-muted hover:bg-main hover:text-body"
          >
            <X className="h-4 w-4" aria-hidden />
          </button>
          {children}
        </aside>
      </div>
    </div>
  );
}
