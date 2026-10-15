import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import { createTenantServerClient } from '@/lib/supabase/tenant-server';
import { gatePortalPage, can } from '@/lib/permissions';
import { getTenantEntitlement } from '@/lib/entitlements';
import { PlanUpgradePaywall } from '@/components/PlanUpgradePaywall';
import { OwnerBranchesManager } from '@/components/OwnerBranches';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Branches' };

/**
 * Independent branches, managed from the owner's central panel. Each branch is a
 * restaurant of its own (own database, staff, stock, orders, finance and portals);
 * this page creates them, follows their setup and opens their workspaces.
 */
export default async function BranchesPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const t = await createTenantServerClient(slug);
  if (!t) notFound();
  const { role, perms } = await gatePortalPage(t.client, slug, 'branches.view');
  // A branch's own workspace never manages branches — that is the owner panel's job.
  if (t.config.parentSlug) redirect(`/r/${slug}`);
  const ent = await getTenantEntitlement(t.client, t.config.tier);
  if (!ent.isEntitled('branches.multi')) {
    return <PlanUpgradePaywall slug={slug} featureKey="branches.multi" currentTier={ent.tier} />;
  }
  const isOwner = role === 'owner' || perms.includes('*');

  return (
    <div className="space-y-6 max-w-6xl">
      <div>
        <h1 className="text-xl font-black">Branches</h1>
        <p className="text-muted text-xs mt-1 max-w-2xl">
          {t.config.restaurantName}’s branches. Each one is an independent restaurant with its own workspace and records; this owner
          panel creates them, shows how each is doing, and opens any of them with the Workspace selector — without signing out.
        </p>
      </div>
      <OwnerBranchesManager slug={slug} canCreate={isOwner && can(perms, role, 'branches.manage')} />
    </div>
  );
}
