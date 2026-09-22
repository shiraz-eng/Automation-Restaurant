import { ArrowRight } from 'lucide-react';
import { Reveal } from '@/components/marketing/Reveal';

const LABELS: { text: string[]; top: string; left: string }[] = [
  { text: ['Floor', 'Operations'], top: '18%', left: '20%' },
  { text: ['Server', 'Live Ops'], top: '30%', left: '58%' },
  { text: ['Table', 'Orders'], top: '62%', left: '20%' },
  { text: ['Dining', 'Customer Experience'], top: '70%', left: '66%' },
];

export function VisualShowcase() {
  return (
    <section className="bg-ink text-ink-fg border-t border-white/5">
      <div className="mx-auto max-w-6xl px-5 md:px-8 pt-14 md:pt-16 pb-16 md:pb-24">
        <Reveal>
          <span className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.04] px-3.5 py-1.5 text-[11px] font-bold uppercase tracking-[0.14em] text-ink-muted">
            Visual Showcase
          </span>
          <h2 className="font-display text-3xl md:text-[2.6rem] font-semibold leading-[1.1] tracking-tight mt-4 max-w-2xl">
            Everything Your Restaurant Needs. In One System.
          </h2>
          <p className="text-ink-muted text-base md:text-lg mt-4 max-w-xl">
            One platform, layered across the restaurant you already run — the floor, the kitchen,
            the storeroom and the office all feed the same connected system.
          </p>
        </Reveal>

        <Reveal delay={100}>
          <div className="relative mt-10 rounded-3xl overflow-hidden border border-white/10 aspect-[16/9] sm:aspect-[21/9]">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="/images/dining-room.jpg"
              alt="A modern restaurant dining room with guests and staff in motion"
              className="absolute inset-0 h-full w-full object-cover"
            />
            <div className="absolute inset-0 bg-gradient-to-t from-black/60 via-black/10 to-black/40" />
            {LABELS.map((l) => (
              <div
                key={l.text.join('-')}
                className="absolute -translate-x-1/2 -translate-y-1/2 flex items-center gap-1.5 rounded-full border border-white/15 bg-ink/80 backdrop-blur-md px-3 py-1.5 text-[11px] font-semibold shadow-lg whitespace-nowrap"
                style={{ top: l.top, left: l.left }}
              >
                <span className="text-ink-muted">{l.text[0]}</span>
                <ArrowRight size={11} className="text-gold shrink-0" />
                <span className="text-ink-fg">{l.text[1]}</span>
              </div>
            ))}
          </div>
        </Reveal>
      </div>
    </section>
  );
}
