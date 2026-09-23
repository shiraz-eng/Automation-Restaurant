import Link from 'next/link';
import { AlertTriangle, ArrowRight, ArrowUpRight, ChefHat, Sparkles } from 'lucide-react';
import { getSectionContent } from '@/lib/cms/content';
import type { HeroContent } from '@/lib/cms/schemas';

const DEFAULT: HeroContent = {
  badge: 'The Restaurant Operating System',
  headline: 'The Operating System for Your Restaurant.',
  subhead:
    'Connecting your entire operation: Orders → Operations → Kitchen → Inventory → Purchasing → Finance → Marketing → Analytics → Customers → AI.',
  primaryCta: { label: 'Get Started', href: '/get-started' },
  secondaryCta: { label: 'Explore the Platform', href: '/#platform' },
  connects: ['Orders', 'Operations', 'Kitchen', 'Inventory', 'Purchasing', 'Finance', 'Marketing', 'Analytics', 'Customers', 'AI'],
  image: { src: '/images/hero-dark-kitchen.jpg', alt: 'Chefs working the pass in a modern restaurant kitchen' },
  kitchenTickets: [
    { table: 'Table 5', status: 'In Prep' },
    { table: 'Table 6', status: 'In Prep' },
    { table: 'Table 7', status: 'In Prep' },
    { table: 'Table 8', status: 'Ready' },
  ],
  inventoryAlert: { title: 'Inventory alert', text: 'Low stock: 3 ingredients' },
  aiRecommendation: {
    title: 'AI Recommendation',
    text: 'Ribeye is trending toward a stockout before Saturday service — reorder suggested.',
    linkText: 'Review inventory',
  },
};

export async function Hero({ previewContent }: { previewContent?: HeroContent } = {}) {
  if (previewContent) return <HeroView content={previewContent} />;
  const result = await getSectionContent('hero', 'hero');
  if (result.state === 'hidden') return null;
  const content = result.state === 'active' ? result.content : DEFAULT;
  return <HeroView content={content} />;
}

function HeroView({ content }: { content: HeroContent }) {
  return (
    <section className="relative overflow-hidden bg-ink text-ink-fg">
      {/* Warm radial glow behind the copy — restrained, not a full gradient wash */}
      <div
        className="pointer-events-none absolute -left-40 -top-40 h-[560px] w-[560px] rounded-full opacity-[0.14] blur-3xl"
        style={{ background: 'radial-gradient(circle, rgb(var(--gold)) 0%, transparent 70%)' }}
      />
      <div className="relative mx-auto max-w-6xl px-5 md:px-8 pt-14 md:pt-20 pb-16 md:pb-24">
        <div className="grid gap-10 lg:grid-cols-2 lg:gap-8 items-center">
          {/* Copy */}
          <div className="relative">
            <span className="inline-flex items-center gap-2 rounded-full border border-gold/25 bg-gold/[0.07] px-3.5 py-1.5 text-[11px] font-bold uppercase tracking-[0.14em] text-gold">
              {content.badge}
            </span>
            <h1 className="font-display text-4xl sm:text-5xl md:text-[3.15rem] font-semibold leading-[1.08] tracking-tight mt-6">
              {content.headline}
            </h1>
            <p className="text-ink-muted text-base md:text-lg mt-5 leading-relaxed max-w-lg">{content.subhead}</p>
            <div className="mt-8 flex flex-wrap items-center gap-3">
              <Link
                href={content.primaryCta.href}
                className="group inline-flex items-center gap-2 rounded-full bg-black border border-gold/30 text-white font-bold px-6 py-3 shadow-[0_0_0_0_rgba(202,138,4,0)] transition-all hover:-translate-y-0.5 hover:border-gold/60 hover:shadow-[0_0_24px_-4px_rgba(202,138,4,0.35)]"
              >
                {content.primaryCta.label}
                <ArrowRight size={16} className="transition-transform group-hover:translate-x-0.5" />
              </Link>
              <Link
                href={content.secondaryCta.href}
                className="rounded-full border border-white/15 font-semibold px-6 py-3 hover:bg-white/5 transition-colors"
              >
                {content.secondaryCta.label}
              </Link>
            </div>

            <div className="mt-10 flex flex-wrap gap-x-4 gap-y-2 max-w-md">
              {content.connects.map((c, i) => (
                <span key={c} className="flex items-center gap-1.5 text-xs font-medium text-ink-muted">
                  {c}
                  {i < content.connects.length - 1 && <ArrowRight size={11} className="text-white/20" />}
                </span>
              ))}
            </div>
          </div>

          {/* Photography + floating product cards */}
          <div className="relative aspect-[3/4] sm:aspect-[16/11] lg:aspect-auto lg:h-[480px] rounded-3xl overflow-hidden border border-white/10">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={content.image.src}
              alt={content.image.alt}
              className="absolute inset-0 h-full w-full object-cover"
            />
            <div className="absolute inset-0 bg-gradient-to-t from-black/70 via-black/10 to-black/30" />

            {/* Sales Analytics card — hidden below sm: the 4-card layout
                needs more height than a mobile 4:3 crop gives it, so mobile
                keeps only the two bottom cards (see PhotoPanel note below). */}
            <div className="hidden sm:block absolute left-5 top-5 w-44 rounded-xl border border-white/10 bg-ink/85 backdrop-blur-md p-3 shadow-xl">
              <div className="flex items-center justify-between text-[10px] font-semibold text-ink-muted">
                Sales Analytics
                <span className="text-white/30">···</span>
              </div>
              <svg viewBox="0 0 140 44" className="mt-2 w-full h-9" preserveAspectRatio="none">
                <polyline
                  points="0,34 18,30 36,32 54,18 72,22 90,10 108,14 126,4 140,8"
                  fill="none"
                  stroke="rgb(var(--gold))"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </div>

            {/* Inventory alert badge */}
            <div className="hidden sm:flex absolute right-5 top-5 items-center gap-2 rounded-xl border border-warn/30 bg-ink/85 backdrop-blur-md px-3 py-2 shadow-xl">
              <AlertTriangle size={14} className="shrink-0 text-warn" />
              <div className="text-[10px] leading-tight">
                <div className="font-bold text-ink-fg">{content.inventoryAlert.title}</div>
                <div className="text-ink-muted">{content.inventoryAlert.text}</div>
              </div>
            </div>

            {/* Kitchen Display card — top on mobile (where the two hidden
                cards would have sat), bottom-left on desktop. */}
            <div className="absolute left-3 top-3 sm:left-5 sm:top-auto sm:bottom-20 w-[172px] sm:w-48 rounded-xl border border-white/10 bg-ink/85 backdrop-blur-md p-3 shadow-xl">
              <div className="flex items-center justify-between text-[10px] font-semibold text-ink-fg mb-1.5">
                <span className="flex items-center gap-1.5">
                  <ChefHat size={11} className="text-gold" />
                  Kitchen Display
                </span>
                <span className="rounded-full bg-ok/20 text-ok px-1.5 py-0.5 text-[8.5px] font-bold">Active</span>
              </div>
              <ul className="space-y-1">
                {content.kitchenTickets.map((t) => (
                  <li key={t.table} className="flex items-center justify-between text-[9.5px]">
                    <span className="text-ink-muted">{t.table}</span>
                    <span
                      className={`rounded px-1.5 py-0.5 font-semibold ${
                        t.status === 'Ready' ? 'bg-ok/20 text-ok' : 'bg-gold/20 text-gold'
                      }`}
                    >
                      {t.status}
                    </span>
                  </li>
                ))}
              </ul>
            </div>

            {/* AI Recommendation card */}
            <div className="absolute right-3 bottom-3 sm:right-5 sm:bottom-5 w-[200px] sm:w-56 rounded-xl border border-gold/20 bg-ink/90 backdrop-blur-md p-3 shadow-xl">
              <div className="flex items-center gap-1.5 text-[10px] font-bold text-gold mb-1">
                <Sparkles size={12} />
                {content.aiRecommendation.title}
              </div>
              <p className="text-[10px] text-ink-muted leading-snug">{content.aiRecommendation.text}</p>
              <div className="mt-1.5 flex items-center gap-1 text-[9.5px] font-semibold text-ink-fg">
                {content.aiRecommendation.linkText} <ArrowUpRight size={10} />
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
