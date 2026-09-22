import type { ReactNode } from 'react';

/** A real product UI card layered over restaurant photography — the same
 *  "photo + floating product UI" treatment as the hero, reused for feature
 *  sections whose product view is genuinely tied to a physical scene (the
 *  Kitchen Display over an actual kitchen). */
export function PhotoWithMockup({ src, alt, children }: { src: string; alt: string; children: ReactNode }) {
  return (
    <div className="relative rounded-2xl overflow-hidden border border-border aspect-[4/3] sm:aspect-[16/11]">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={src} alt={alt} className="absolute inset-0 h-full w-full object-cover" />
      <div className="absolute inset-0 bg-gradient-to-t from-black/55 via-black/5 to-transparent" />
      <div className="absolute inset-x-3 bottom-3 sm:inset-x-4 sm:bottom-4">
        <div className="rounded-xl border border-white/10 bg-ink/85 backdrop-blur-md overflow-hidden shadow-xl text-ink-fg">
          {children}
        </div>
      </div>
    </div>
  );
}
