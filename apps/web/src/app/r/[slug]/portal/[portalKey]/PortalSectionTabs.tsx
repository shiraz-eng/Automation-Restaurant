'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * A station portal shows one section at a time (Kitchen, Cashier, …) instead of
 * every section stacked on one long page: large touch tabs, the chosen section
 * kept in the URL (#kitchen) so a device reopens where it was, and ←/→ between
 * tabs. The other sections stay rendered (live boards keep their data) but are
 * hidden, so switching is instant.
 */
export function PortalSectionTabs({ sections }: { sections: { id: string; label: string }[] }) {
  const [active, setActive] = useState(sections[0]?.id ?? '');
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);

  useEffect(() => {
    const fromHash = () => {
      const h = decodeURIComponent(window.location.hash.slice(1));
      if (sections.some((s) => s.id === h)) setActive(h);
    };
    fromHash();
    window.addEventListener('hashchange', fromHash);
    return () => window.removeEventListener('hashchange', fromHash);
  }, [sections]);

  function select(id: string, focus = false) {
    setActive(id);
    window.history.replaceState(null, '', `#${id}`);
    window.scrollTo({ top: 0 });
    if (focus) tabs.current[sections.findIndex((s) => s.id === id)]?.focus();
  }

  function onKey(e: React.KeyboardEvent, i: number) {
    const next = e.key === 'ArrowRight' ? i + 1 : e.key === 'ArrowLeft' ? i - 1 : e.key === 'Home' ? 0 : e.key === 'End' ? sections.length - 1 : null;
    if (next === null) return;
    e.preventDefault();
    select(sections[(next + sections.length) % sections.length]!.id, true);
  }

  const hidden = sections.filter((s) => s.id !== active).map((s) => `section#${s.id}`);
  return (
    <>
      {hidden.length > 0 && <style>{`${hidden.join(',')}{display:none}`}</style>}
      <div
        role="tablist"
        aria-label="Sections"
        className="sticky top-0 z-10 -mx-1 flex gap-2 overflow-x-auto border-b border-border bg-main/95 px-1 py-2 backdrop-blur"
      >
        {sections.map((s, i) => (
          <button
            key={s.id}
            ref={(el) => {
              tabs.current[i] = el;
            }}
            type="button"
            role="tab"
            id={`tab-${s.id}`}
            aria-selected={active === s.id}
            aria-controls={s.id}
            tabIndex={active === s.id ? 0 : -1}
            onClick={() => select(s.id)}
            onKeyDown={(e) => onKey(e, i)}
            className={`min-h-11 shrink-0 rounded-full border px-4 text-sm font-semibold transition-colors ${
              active === s.id ? 'border-primary bg-primary text-primary-fg' : 'border-border hover:border-primary/60'
            }`}
          >
            {s.label}
          </button>
        ))}
      </div>
    </>
  );
}
