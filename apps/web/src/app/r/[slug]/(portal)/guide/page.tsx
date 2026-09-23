import { notFound } from 'next/navigation';
import { createTenantServerClient } from '@/lib/supabase/tenant-server';
import { gatePortalPage } from '@/lib/permissions';
import { PortalGuidePageClient } from './PortalGuidePageClient';

export const dynamic = 'force-dynamic';

export default async function PortalGuidePage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const t = await createTenantServerClient(slug);
  if (!t) notFound();

  await gatePortalPage(t.client, slug, '');

  return (
    <PortalGuidePageClient
      slug={slug}
      restaurantName={t.config.restaurantName}
      planTier={t.config.tier ?? undefined}
      subscriptionStatus={t.config.subscriptionStatus ?? undefined}
    />
  );
}
