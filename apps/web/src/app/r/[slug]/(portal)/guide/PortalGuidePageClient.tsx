'use client';

import Link from 'next/link';
import { ChefHat, Utensils, Users, Palette, CreditCard, Sparkles, AlertCircle } from 'lucide-react';
import { GuideAiPanel } from '@/components/GuideAiPanel';
import { usePortalSupabase } from '@/components/PortalProvider';

export interface PortalGuidePageClientProps {
  slug: string;
  restaurantName: string;
  planTier?: string;
  subscriptionStatus?: string;
}

const QUICK_ACTIONS = [
  {
    icon: Utensils,
    title: 'Setup Menu',
    desc: 'Add categories, items, and pricing',
    href: (slug: string) => `/r/${slug}/menu`,
  },
  {
    icon: Users,
    title: 'Invite Staff',
    desc: 'Create team logins and permissions',
    href: (slug: string) => `/r/${slug}/staff`,
  },
  {
    icon: Palette,
    title: 'Brand Kit',
    desc: 'Customize colors, logos, and receipt styles',
    href: (slug: string) => `/r/${slug}/settings/theme`,
  },
  {
    icon: CreditCard,
    title: 'Subscription & Billing',
    desc: 'Review tier, invoices, and payment status',
    href: (slug: string) => `/r/${slug}/billing`,
  },
];

export function PortalGuidePageClient({
  slug,
  restaurantName,
  planTier,
  subscriptionStatus,
}: PortalGuidePageClientProps) {
  const supabase = usePortalSupabase();

  const getToken = async (): Promise<string | null> => {
    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      return session?.access_token ?? null;
    } catch {
      return null;
    }
  };

  return (
    <div className="space-y-6 max-w-5xl">
      {/* Header */}
      <div>
        <div className="flex items-center gap-2">
          <span className="grid h-7 w-7 place-items-center rounded-lg bg-gold text-ink">
            <ChefHat size={16} strokeWidth={2.4} />
          </span>
          <h1 className="text-xl font-black text-body">Automation Restaurant AI Guide</h1>
          <span className="inline-flex items-center gap-1 rounded-full border border-gold/30 bg-gold/10 px-2.5 py-0.5 text-[10px] font-bold text-gold">
            <Sparkles size={10} />
            <span>Product & Setup Specialist</span>
          </span>
        </div>
        <p className="text-muted text-xs mt-1">
          Your account-aware guide for {restaurantName}. Ask questions about configuring your restaurant,
          diagnosing issues, understanding your subscription, or unlocking features.
        </p>
      </div>

      {/* Quick navigation cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {QUICK_ACTIONS.map((action, i) => {
          const Icon = action.icon;
          return (
            <Link
              key={i}
              href={action.href(slug)}
              className="rounded-xl border border-border bg-surface p-3.5 hover:border-gold/50 transition-colors group flex flex-col justify-between"
            >
              <div className="flex items-center justify-between mb-2">
                <span className="grid h-8 w-8 place-items-center rounded-lg bg-main group-hover:bg-gold/10 text-muted group-hover:text-gold transition-colors">
                  <Icon size={16} />
                </span>
              </div>
              <div>
                <div className="text-xs font-bold text-body group-hover:text-gold transition-colors">
                  {action.title}
                </div>
                <div className="text-[10px] text-muted mt-0.5 line-clamp-1">{action.desc}</div>
              </div>
            </Link>
          );
        })}
      </div>

      {/* Embedded Full AI Panel */}
      <div className="bg-surface rounded-xl border border-border p-1 shadow-sm">
        <GuideAiPanel
          mode="portal"
          slug={slug}
          page={`/r/${slug}/guide`}
          restaurantName={restaurantName}
          planTier={planTier}
          subscriptionStatus={subscriptionStatus}
          getToken={getToken}
          embedded={true}
        />
      </div>

      {/* Security reminder */}
      <div className="rounded-xl border border-border bg-surface/50 p-4 text-xs text-muted flex items-start gap-2.5">
        <AlertCircle size={15} className="text-gold shrink-0 mt-0.5" />
        <div className="text-[11px] leading-relaxed">
          The AI Guide diagnoses account issues using authorized control-plane metadata only. It will never ask
          for database passwords, Stripe secrets, or private credentials.
        </div>
      </div>
    </div>
  );
}
