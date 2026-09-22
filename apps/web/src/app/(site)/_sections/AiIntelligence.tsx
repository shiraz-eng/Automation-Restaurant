import { Banknote, ChefHat, Crown, MessageCircleHeart, Package, TrendingUp } from 'lucide-react';
import { Eyebrow } from '@/components/marketing/Section';
import { Reveal } from '@/components/marketing/Reveal';

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
          <Eyebrow tone="dark">AI Intelligence</Eyebrow>
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
