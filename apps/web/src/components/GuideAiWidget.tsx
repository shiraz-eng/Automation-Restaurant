'use client';

import { useState, useEffect, useRef } from 'react';
import { usePathname } from 'next/navigation';
import { ChefHat, X, Sparkles } from 'lucide-react';
import { GuideAiPanel, type GuideAiPanelProps } from './GuideAiPanel';
import { logGuideEvent, makeSessionId } from '@/lib/guideAi';
import { stopSpeech } from '@/lib/ai/speech';

export interface GuideAiWidgetProps extends Omit<GuideAiPanelProps, 'onClose' | 'embedded' | 'autoFocus'> {
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
  dataPanel,
  initiallyOpen = false,
}: GuideAiWidgetProps) {
  // Public pages don't pass the path in; recommendations still follow the page.
  const pathname = usePathname();
  const currentPage = page ?? pathname ?? undefined;
  const [isOpen, setIsOpen] = useState(initiallyOpen);
  const [hasInteracted, setHasInteracted] = useState(false);
  const launcherRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (isOpen) {
      logGuideEvent('widget_opened', makeSessionId(), { page, mode }, slug);
    } else if (hasInteracted) {
      logGuideEvent('widget_closed', makeSessionId(), { page, mode }, slug);
    }
  }, [isOpen, hasInteracted, page, mode, slug]);

  const close = () => {
    stopSpeech();
    setIsOpen(false);
    // Back to the button that opened it, so keyboard users don't lose their place.
    requestAnimationFrame(() => launcherRef.current?.focus());
  };
  const toggle = () => {
    setHasInteracted(true);
    if (isOpen) close();
    else setIsOpen(true);
  };

  return (
    <div className="fixed bottom-4 end-4 sm:bottom-5 sm:end-5 z-50 flex flex-col items-end">
      {/* Expanded panel: a non-modal dialog — the page behind stays usable. */}
      {isOpen && (
        <div
          role="dialog"
          aria-modal="false"
          aria-label="AI Guide"
          id="ai-guide-panel"
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.stopPropagation();
              close();
            }
          }}
          // The launcher sits under the panel: the panel takes the rest of the screen height at most,
          // so its header (close, language) never goes off the top on a short or landscape screen.
          className="mb-3 w-[92vw] max-w-[420px] h-[600px] max-h-[calc(100dvh-6.5rem)] bg-surface transition-all duration-200 motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-3 shadow-2xl rounded-2xl overflow-hidden border border-border"
        >
          <GuideAiPanel
            mode={mode}
            slug={slug}
            page={currentPage}
            restaurantName={restaurantName}
            planTier={planTier}
            subscriptionStatus={subscriptionStatus}
            getToken={getToken}
            dataPanel={dataPanel}
            onClose={close}
            embedded={false}
            autoFocus
          />
        </div>
      )}

      {/* Floating launcher button */}
      <button
        ref={launcherRef}
        onClick={toggle}
        aria-label={isOpen ? 'Close AI Guide' : 'Open AI Guide'}
        aria-expanded={isOpen}
        aria-controls={isOpen ? 'ai-guide-panel' : undefined}
        className="group relative flex items-center gap-2.5 rounded-full bg-ink p-2 sm:px-4 sm:py-3 text-ink-fg shadow-xl transition-all duration-200 hover:scale-105 active:scale-95 border border-white/10 hover:border-gold/50"
      >
        <span className="grid h-7 w-7 place-items-center rounded-full bg-gold text-ink font-bold shadow-sm transition-transform group-hover:rotate-6" aria-hidden>
          {isOpen ? <X size={16} strokeWidth={2.5} /> : <ChefHat size={16} strokeWidth={2.4} />}
        </span>
        {/* Phones: icon only, so the launcher covers as little of the page as possible. */}
        <div className="hidden sm:flex flex-col text-start" aria-hidden>
          <span className="text-[0.75rem] font-bold tracking-tight text-white flex items-center gap-1">
            AI Guide
            <Sparkles size={11} className="text-gold" />
          </span>
          <span className="text-[0.625rem] text-ink-muted leading-none">
            {mode === 'portal' ? 'Help, voice & your data' : 'Setup & plans, answered fast'}
          </span>
        </div>
      </button>
    </div>
  );
}
