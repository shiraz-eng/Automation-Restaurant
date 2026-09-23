'use client';

import { useState, useEffect } from 'react';
import { ChefHat, X, Sparkles } from 'lucide-react';
import { GuideAiPanel, type GuideAiPanelProps } from './GuideAiPanel';
import { logGuideEvent, makeSessionId } from '@/lib/guideAi';

export interface GuideAiWidgetProps extends Omit<GuideAiPanelProps, 'onClose' | 'embedded'> {
  initiallyOpen?: boolean;
}

export function GuideAiWidget({
  mode,
  slug,
  page,
  restaurantName,
  planTier,
  subscriptionStatus,
  getToken,
  initiallyOpen = false,
}: GuideAiWidgetProps) {
  const [isOpen, setIsOpen] = useState(initiallyOpen);
  const [hasInteracted, setHasInteracted] = useState(false);

  useEffect(() => {
    if (isOpen) {
      logGuideEvent('widget_opened', makeSessionId(), { page, mode }, slug);
    } else if (hasInteracted) {
      logGuideEvent('widget_closed', makeSessionId(), { page, mode }, slug);
    }
  }, [isOpen, hasInteracted, page, mode, slug]);

  const toggle = () => {
    setHasInteracted(true);
    setIsOpen((prev) => !prev);
  };

  return (
    <div className="fixed bottom-5 right-5 z-50 flex flex-col items-end">
      {/* Expanded panel */}
      {isOpen && (
        <div className="mb-3 w-[92vw] max-w-[420px] h-[580px] max-h-[82vh] transition-all duration-200 animate-in fade-in slide-in-from-bottom-3 shadow-2xl rounded-2xl overflow-hidden border border-border">
          <GuideAiPanel
            mode={mode}
            slug={slug}
            page={page}
            restaurantName={restaurantName}
            planTier={planTier}
            subscriptionStatus={subscriptionStatus}
            getToken={getToken}
            onClose={() => setIsOpen(false)}
            embedded={false}
          />
        </div>
      )}

      {/* Floating launcher button */}
      <button
        onClick={toggle}
        aria-label={isOpen ? 'Close AI Guide' : 'Open AI Guide'}
        className="group relative flex items-center gap-2.5 rounded-full bg-ink px-4 py-3 text-ink-fg shadow-xl transition-all duration-200 hover:scale-105 active:scale-95 border border-white/10 hover:border-gold/50"
      >
        <span className="grid h-7 w-7 place-items-center rounded-full bg-gold text-ink font-bold shadow-sm transition-transform group-hover:rotate-6">
          {isOpen ? <X size={16} strokeWidth={2.5} /> : <ChefHat size={16} strokeWidth={2.4} />}
        </span>
        <div className="flex flex-col text-left">
          <span className="text-[12px] font-bold tracking-tight text-white flex items-center gap-1">
            AI Guide
            <Sparkles size={11} className="text-gold" />
          </span>
          <span className="text-[10px] text-ink-muted leading-none">
            {mode === 'portal' ? 'Product & Setup Guide' : 'Ask anything'}
          </span>
        </div>
      </button>
    </div>
  );
}
