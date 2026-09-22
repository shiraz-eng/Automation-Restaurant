'use client';

import { useEffect, useRef } from 'react';

export type NavSection = { id: string; label: string };

/** Sticky, horizontally-scrollable category pills. Clicking one scrolls the
 *  matching menu section into view; `activeId` (driven by the parent's
 *  scroll-spy observer) keeps the pill in sync with whatever section is
 *  actually on screen, and auto-scrolls the pill strip so the active pill
 *  stays visible on narrow screens. */
export function CategoryNav({
  sections,
  activeId,
  onPick,
  topOffset,
}: {
  sections: NavSection[];
  activeId: string;
  onPick: (id: string) => void;
  topOffset: number;
}) {
  const stripRef = useRef<HTMLDivElement | null>(null);
  const pillRefs = useRef<Map<string, HTMLButtonElement>>(new Map());

  useEffect(() => {
    const pill = pillRefs.current.get(activeId);
    const strip = stripRef.current;
    if (!pill || !strip) return;
    const pillLeft = pill.offsetLeft;
    const pillRight = pillLeft + pill.offsetWidth;
    if (pillLeft < strip.scrollLeft || pillRight > strip.scrollLeft + strip.clientWidth) {
      strip.scrollTo({ left: pillLeft - 16, behavior: 'smooth' });
    }
  }, [activeId]);

  if (sections.length === 0) return null;

  return (
    <div
      className="sticky z-20 bg-main/95 backdrop-blur border-b border-border"
      style={{ top: topOffset }}
    >
      <div ref={stripRef} className="flex gap-2 overflow-x-auto px-4 py-2.5 no-scrollbar">
        {sections.map((s) => {
          const active = s.id === activeId;
          return (
            <button
              key={s.id}
              ref={(el) => {
                if (el) pillRefs.current.set(s.id, el);
              }}
              onClick={() => onPick(s.id)}
              className={`px-3.5 py-1.5 rounded-full text-xs font-bold whitespace-nowrap transition-colors ${
                active ? 'bg-primary text-primary-fg' : 'bg-surface border border-border text-body hover:border-primary/40'
              }`}
            >
              {s.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
