import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import { Reveal } from '@/components/marketing/Reveal';
import { getSectionContent } from '@/lib/cms/content';
import type { CtaContent } from '@/lib/cms/schemas';

const DEFAULT: CtaContent = {
  headline: 'Run your restaurant from one connected system.',
  subtext: 'Bring operations, inventory, finance, staff, customers and intelligence into one place.',
  primaryCta: { label: 'Get Started', href: '/get-started' },
  secondaryCta: { label: 'Book a Demo', href: '/contact' },
};

export async function FinalCta() {
  const result = await getSectionContent('final-cta', 'cta');
  if (result.state === 'hidden') return null;
  const content = result.state === 'active' ? result.content : DEFAULT;
  return (
    <section className="relative overflow-hidden bg-ink text-ink-fg">
      <div
        className="pointer-events-none absolute left-1/2 top-0 h-[420px] w-[720px] -translate-x-1/2 rounded-full opacity-[0.12] blur-3xl"
        style={{ background: 'radial-gradient(circle, rgb(var(--gold)) 0%, transparent 70%)' }}
      />
      <div className="relative mx-auto max-w-4xl px-5 md:px-8 py-24 md:py-32 text-center">
        <Reveal>
          <h2 className="font-display text-3xl md:text-5xl font-bold tracking-tight leading-[1.1]">{content.headline}</h2>
          <p className="text-ink-muted mt-4 max-w-xl mx-auto text-base md:text-lg">{content.subtext}</p>
          <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
            <Link
              href={content.primaryCta.href}
              className="group inline-flex items-center gap-2 rounded-full bg-black border border-gold/30 text-white font-bold px-6 py-3 transition-all hover:-translate-y-0.5 hover:border-gold/60 hover:shadow-[0_0_24px_-4px_rgba(202,138,4,0.35)]"
            >
              {content.primaryCta.label}
              <ArrowRight size={16} className="transition-transform group-hover:translate-x-0.5" />
            </Link>
            <Link href={content.secondaryCta.href} className="rounded-full border border-white/15 font-semibold px-6 py-3 hover:bg-white/5 transition-colors">
              {content.secondaryCta.label}
            </Link>
          </div>
        </Reveal>
      </div>
    </section>
  );
}
