'use client';

import { ShoppingBag } from 'lucide-react';
import { formatCents } from '@/lib/format';

/** Persistent bottom bar shown once the cart has items — unobtrusive,
 *  doesn't cover menu content, opens the full cart sheet on tap. */
export function MobileCartBar({ count, total, onOpen }: { count: number; total: number; onOpen: () => void }) {
  if (count === 0) return null;
  return (
    <div className="lg:hidden fixed bottom-3 inset-x-3 z-30">
      <button
        onClick={onOpen}
        className="w-full rounded-full bg-primary text-primary-fg shadow-lg shadow-black/20 px-4 py-3.5 flex items-center justify-between active:scale-[0.99] transition-transform"
      >
        <span className="flex items-center gap-2 text-sm font-bold">
          <span className="relative">
            <ShoppingBag size={18} />
            <span className="absolute -top-1.5 -right-1.5 bg-primary-fg text-primary text-[9px] font-black rounded-full w-4 h-4 grid place-items-center">
              {count}
            </span>
          </span>
          View cart
        </span>
        <span className="text-sm font-black">{formatCents(total)}</span>
      </button>
    </div>
  );
}
