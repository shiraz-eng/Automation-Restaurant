'use client';

import dynamic from 'next/dynamic';
import { usePathname } from 'next/navigation';
import { aiModuleForPath } from '@automation-restaurant/shared';
import { usePortalSupabase } from './PortalProvider';
import { GuideAiWidget } from './GuideAiWidget';

// The data Assistant is only downloaded when someone opens its tab.
const AiChat = dynamic(() => import('@/app/r/[slug]/(portal)/ai/AiChat').then((m) => m.AiChat), {
  ssr: false,
  loading: () => <p className="p-4 text-xs text-muted" role="status">Loading the assistant…</p>,
});

export interface PortalGuideAiWidgetProps {
  slug: string;
  restaurantName: string;
  planTier?: string;
  subscriptionStatus?: string;
  /** Holds ai.view and the plan includes the Assistant. */
  canUseAssistant?: boolean;
}

export function PortalGuideAiWidget({
  slug,
  restaurantName,
  planTier,
  subscriptionStatus,
  canUseAssistant = false,
}: PortalGuideAiWidgetProps) {
  const supabase = usePortalSupabase();
  const pathname = usePathname();

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
    <GuideAiWidget
      mode="portal"
      slug={slug}
      page={pathname}
      restaurantName={restaurantName}
      planTier={planTier}
      subscriptionStatus={subscriptionStatus}
      getToken={getToken}
      // On the Assistant page itself the full chat is already on screen.
      dataPanel={canUseAssistant && !/\/ai\/?$/.test(pathname ?? '') ? <AiChat slug={slug} module={aiModuleForPath(pathname)} compact /> : undefined}
    />
  );
}
