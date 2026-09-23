import type { Metadata } from 'next';
import { ChefHat, Sparkles, Compass, ShieldCheck, Zap, Database, HelpCircle } from 'lucide-react';
import { GuideAiPanel } from '@/components/GuideAiPanel';

export const metadata: Metadata = {
  title: 'AI Guide & Platform Assistant — Automation Restaurant',
  description:
    'Ask anything about Automation Restaurant: platform architecture, role-specific portals, pricing, onboarding, Supabase infrastructure, and setup diagnosis.',
};

const TOPICS = [
  {
    icon: Compass,
    title: 'Platform & Portals',
    desc: 'Learn how role-based portals for Kitchen, Cashier, Floor, and Owner work seamlessly together.',
  },
  {
    icon: Zap,
    title: 'Plans & Entitlements',
    desc: 'Understand plan tiers, feature limits, and choose the right capabilities for your restaurant.',
  },
  {
    icon: Database,
    title: 'Supabase Infrastructure',
    desc: 'Explore dedicated project isolation, row-level security, and production database setups.',
  },
  {
    icon: ShieldCheck,
    title: 'Setup & Diagnostics',
    desc: 'Diagnose connection issues, verify project readiness, and get guided onboarding steps.',
  },
];

export default function GuidePage() {
  return (
    <div className="py-12 md:py-20">
      <div className="mx-auto max-w-6xl px-5">
        {/* Hero */}
        <div className="text-center max-w-3xl mx-auto mb-12">
          <div className="inline-flex items-center gap-2 rounded-full border border-gold/30 bg-gold/10 px-3.5 py-1 text-xs font-semibold text-gold mb-4">
            <Sparkles size={13} />
            <span>Product Specialist & Onboarding Assistant</span>
          </div>
          <h1 className="font-display text-3xl sm:text-5xl font-bold tracking-tight text-body">
            Automation Restaurant <span className="text-gold">AI Guide</span>
          </h1>
          <p className="mt-4 text-sm sm:text-base text-muted leading-relaxed">
            Your interactive assistant for exploring the platform, choosing plans, configuring your account,
            and diagnosing setup questions in plain language.
          </p>
        </div>

        {/* Two-column layout: Info + Embedded AI Panel */}
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-start">
          {/* Left: Topics and info */}
          <div className="lg:col-span-5 space-y-4">
            <div className="bg-surface rounded-xl border border-border p-6 shadow-sm">
              <div className="flex items-center gap-2 font-display font-semibold text-lg text-body mb-2">
                <span className="grid h-7 w-7 place-items-center rounded-lg bg-gold text-ink">
                  <ChefHat size={16} strokeWidth={2.4} />
                </span>
                <span>How the Guide Works</span>
              </div>
              <p className="text-xs text-muted leading-relaxed mb-4">
                The AI Guide has authoritative access to Automation Restaurant documentation, plan
                specifications, and FAQs. It explains complex restaurant tech in simple, actionable steps.
              </p>
              <div className="space-y-3">
                {TOPICS.map((topic, i) => {
                  const Icon = topic.icon;
                  return (
                    <div key={i} className="flex gap-3 items-start p-2.5 rounded-lg bg-main border border-border/60">
                      <div className="grid h-7 w-7 place-items-center rounded-md bg-gold/10 text-gold shrink-0 mt-0.5">
                        <Icon size={14} />
                      </div>
                      <div>
                        <div className="text-xs font-bold text-body">{topic.title}</div>
                        <div className="text-[11px] text-muted leading-relaxed mt-0.5">{topic.desc}</div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            <div className="rounded-xl border border-border bg-main p-5 text-xs text-muted space-y-2">
              <div className="font-semibold text-body flex items-center gap-1.5">
                <HelpCircle size={14} className="text-gold" />
                <span>Security & Confidentiality</span>
              </div>
              <p>
                The AI Guide will never ask for secret keys, passwords, or payment credentials. For real-time
                account diagnostics, log in to your restaurant portal.
              </p>
            </div>
          </div>

          {/* Right: Embedded Interactive Assistant */}
          <div className="lg:col-span-7">
            <GuideAiPanel mode="public" embedded={true} />
          </div>
        </div>
      </div>
    </div>
  );
}
