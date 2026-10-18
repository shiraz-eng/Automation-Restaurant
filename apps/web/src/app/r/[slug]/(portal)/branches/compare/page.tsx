import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import { createTenantServerClient } from '@/lib/supabase/tenant-server';
import { gatePortalPage } from '@/lib/permissions';
import { getTenantEntitlement } from '@/lib/entitlements';
import { PlanUpgradePaywall } from '@/components/PlanUpgradePaywall';
import { BranchComparison } from '@/components/OwnerBranches';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Compare branches' };

/** Every branch side by side, from each branch's own database — owner panel only. */
export default async function CompareBranchesPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const t = await createTenantServerClient(slug);
  if (!t) notFound();
  const { role, perms } = await gatePortalPage(t.client, slug, 'branches.view');
  // A branch workspace (and its manager) never compares branches.
  if (t.config.parentSlug || !(role === 'owner' || perms.includes('*'))) redirect(`/r/${slug}`);
  const ent = await getTenantEntitlement(t.client, t.config.tier);
  if (!ent.isEntitled('branches.multi')) {
    return <PlanUpgradePaywall slug={slug} featureKey="branches.multi" currentTier={ent.tier} />;
  }
  return (
    <div className="space-y-6 max-w-7xl">
      <div>
        <h1 className="text-xl font-black">Compare branches</h1>
        <p className="text-muted text-xs mt-1 max-w-2xl">
          Orders, sales, food cost, expenses and profit for each branch over the same period, with the total.
        </p>
      </div>
      <BranchComparison slug={slug} />
    </div>
  );
}
