'use client';

import { useState } from 'react';
import { AiChat } from '@/app/r/[slug]/(portal)/ai/AiChat';

/**
 * The same AiChat the Operations Portal's own Assistant page uses, dropped
 * into a dedicated role portal (Kitchen/Floor/Deliveries/Finance) — "it
 * should implement this in portal too where its data matched". No second
 * chat implementation: the backend already scopes tools/actions to
 * whatever the caller's own role/permissions allow (routes/ai.ts's
 * `permits()` filter), so a chef here only ever gets kitchen-relevant
 * tools, an accountant only finance ones, etc. — nothing extra to wire up
 * per portal. Collapsed by default so it doesn't compete for space on a
 * busy real-time board; the page that renders this has already checked
 * the caller holds ai.view before doing so.
 */
export function PortalAiWidget({ slug }: { slug: string }) {
  const [open, setOpen] = useState(false);

  return (
    <div className="mt-6">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1.5 text-xs font-semibold text-muted hover:text-body"
      >
        <span className="inline-block w-3">{open ? '▾' : '▸'}</span>
        AI Assistant
      </button>
      {open && (
        <div className="mt-2 max-w-2xl">
          <AiChat slug={slug} />
        </div>
      )}
    </div>
  );
}
