import { notFound } from 'next/navigation';
import { createTenantServerClient } from '@/lib/supabase/tenant-server';
import { gatePortalPage } from '@/lib/permissions';
import { PlanUpgradePaywall } from '@/components/PlanUpgradePaywall';
import { getTenantEntitlement } from '@/lib/entitlements';
import { ExportHistoryPanel } from './ExportHistoryPanel';

export const dynamic = 'force-dynamic';

export default async function ExportHistoryPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const t = await createTenantServerClient(slug);
  if (!t) notFound();
  await gatePortalPage(t.client, slug, 'reports.view');

  const ent = await getTenantEntitlement(t.client, t.config.tier);
  if (!ent.isEntitled('analytics.advanced')) {
    return <PlanUpgradePaywall slug={slug} featureKey="analytics.advanced" currentTier={ent.tier} />;
  }

  return (
    <div className="space-y-4 max-w-4xl">
      <div>
        <h1 className="text-xl font-black">Report &amp; Export History</h1>
        <p className="text-muted text-xs mt-1">
          Every PDF report and Excel export generated for this restaurant — who requested it, when, and for which
          period. Reports aren&apos;t stored here; each one is regenerated fresh from live data every time.
        </p>
      </div>
      <ExportHistoryPanel slug={slug} />
    </div>
  );
}
