'use client';

import { usePathname } from 'next/navigation';
import { usePortalSupabase } from './PortalProvider';
import { GuideAiWidget } from './GuideAiWidget';

export interface PortalGuideAiWidgetProps {
  slug: string;
  restaurantName: string;
  planTier?: string;
  subscriptionStatus?: string;
}

export function PortalGuideAiWidget({
  slug,
  restaurantName,
  planTier,
  subscriptionStatus,
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
    />
  );
}
