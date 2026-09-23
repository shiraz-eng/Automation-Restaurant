import Link from 'next/link';
import { Banknote, ChefHat, Crown, MessageCircleHeart, Package, TrendingUp, Sparkles } from 'lucide-react';
import { Eyebrow } from '@/components/marketing/Section';
import { Reveal } from '@/components/marketing/Reveal';
import { GuideAiPanel } from '@/components/GuideAiPanel';

const LAYERS = [
  {
    icon: MessageCircleHeart,
    title: 'Customer AI',
    text: 'Helps customers discover dishes, deals and combinations, and makes reordering easy.',
  },
  {
    icon: ChefHat,
    title: 'Operations Intelligence',
    text: 'Surfaces operational patterns and issues across orders, kitchen and floor activity.',
  },
  {
    icon: Package,
    title: 'Inventory Intelligence',
    text: 'Flags low-stock conditions, consumption trends and reorder opportunities before they become a problem.',
  },
  {
    icon: Banknote,
    title: 'Finance Intelligence',
    text: 'Analyzes financial data, flags anomalies, and explains where a number came from.',
  },
  {
    icon: TrendingUp,
    title: 'Marketing Intelligence',
    text: 'Reads campaign and promotion performance against real order and customer data.',
  },
  {
    icon: Crown,
    title: 'Owner Intelligence',
    text: 'A connected view across the whole restaurant — the questions an owner actually asks, answered from live data.',
  },
];

export function AiIntelligence() {
  return (
    <section id="ai" className="scroll-mt-20 bg-ink text-ink-fg border-y border-black/20">
      <div className="mx-auto max-w-6xl px-5 md:px-8 py-20 md:py-28">
        <div className="text-center max-w-2xl mx-auto mb-14">
          <Eyebrow tone="dark">AI Intelligence & Automation</Eyebrow>
          <h2 className="font-display text-3xl md:text-[2.75rem] leading-[1.1] font-bold tracking-tight mt-3">
            AI that understands your restaurant.
          </h2>
          <p className="mt-4 text-base md:text-lg text-ink-muted">
            Not a generic chatbot bolted onto the side — purpose-built intelligence layered across
            the parts of the restaurant it actually has data about.
          </p>
        </div>

        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {LAYERS.map((l, i) => (
            <Reveal key={l.title} delay={(i % 3) * 60}>
              <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-5 h-full hover:bg-white/[0.05] transition-colors">
                <div className="grid h-10 w-10 place-items-center rounded-xl bg-gold/15 text-gold">
                  <l.icon size={18} strokeWidth={2} />
                </div>
                <div className="font-display font-bold text-[15px] mt-3.5">{l.title}</div>
                <p className="text-ink-muted text-[13px] mt-1.5 leading-relaxed">{l.text}</p>
              </div>
            </Reveal>
          ))}
        </div>

        {/* Embedded Interactive AI Guide */}
        <div className="mt-14 rounded-2xl border border-gold/30 bg-gradient-to-b from-white/[0.06] to-white/[0.02] p-6 md:p-8">
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-center">
            <div className="lg:col-span-5 space-y-4">
              <div className="inline-flex items-center gap-2 rounded-full border border-gold/30 bg-gold/10 px-3 py-1 text-xs font-semibold text-gold">
                <Sparkles size={12} />
                <span>Interactive Product Specialist</span>
              </div>
              <h3 className="font-display text-2xl md:text-3xl font-bold tracking-tight text-white">
                Try the AI Guide live.
              </h3>
              <p className="text-sm text-ink-muted leading-relaxed">
                Have questions about pricing, features, or setup? Test our live Automation Restaurant
                AI Guide right now. It can explain plan tiers, KDS routing, recipe deductions, and how to get started.
              </p>
              <div className="flex flex-wrap gap-2.5 pt-2">
                <Link
                  href="/guide"
                  className="rounded-lg bg-gold px-4 py-2 text-xs font-bold text-ink hover:opacity-90 transition-opacity flex items-center gap-1.5"
                >
                  <ChefHat size={14} />
                  <span>Full AI Guide Page</span>
                </Link>
                <Link
                  href="/pricing"
                  className="rounded-lg border border-white/20 px-4 py-2 text-xs font-semibold text-white hover:bg-white/10 transition-colors"
                >
                  View All Plans
                </Link>
              </div>
            </div>
            <div className="lg:col-span-7">
              <GuideAiPanel mode="public" embedded={true} />
            </div>
          </div>
        </div>

        <Reveal delay={200}>
          <p className="text-center text-xs text-ink-muted mt-10 max-w-xl mx-auto">
            AI surfaces insight and recommendations — sensitive actions (approvals, purchase
            orders, financial records) stay governed by the platform&rsquo;s own permissions and
            approval workflows, not decided by AI on its own.
          </p>
        </Reveal>
      </div>
    </section>
  );
}
