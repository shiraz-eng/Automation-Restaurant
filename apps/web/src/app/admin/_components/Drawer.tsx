'use client';

import { useEffect } from 'react';
import { X } from 'lucide-react';

/** Shared right-side slide-over — the detail drawer for Customers/Restaurants rows. */
export function Drawer({
  open,
  onClose,
  title,
  subtitle,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      <div className="relative w-full max-w-md h-full bg-ink border-l border-white/10 overflow-y-auto">
        <div className="sticky top-0 bg-ink/95 backdrop-blur border-b border-white/10 p-4 flex items-start justify-between gap-3 z-10">
          <div>
            <div className="font-black text-sm">{title}</div>
            {subtitle && <div className="text-ink-muted text-xs mt-0.5">{subtitle}</div>}
          </div>
          <button onClick={onClose} className="text-ink-muted hover:text-ink-fg shrink-0" aria-label="Close">
            <X size={18} />
          </button>
        </div>
        <div className="p-4 space-y-4">{children}</div>
      </div>
    </div>
  );
}
