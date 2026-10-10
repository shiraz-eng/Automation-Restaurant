import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { createTenantServerClient } from '@/lib/supabase/tenant-server';
import { gatePortalPage, can } from '@/lib/permissions';
import { getTenantEntitlement } from '@/lib/entitlements';
import { loadBranchContext } from '@/lib/branchServer';
import { BranchesManager, type ManagedBranch, type BranchLogin } from './BranchesManager';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Branches' };

export default async function BranchesPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const t = await createTenantServerClient(slug);
  if (!t) notFound();
  const { role, perms } = await gatePortalPage(t.client, slug, 'branches.view');
  const ent = await getTenantEntitlement(t.client, t.config.tier);
  const canManage = can(perms, role, 'branches.manage');

  const [branchesRes, portalsRes, ctx] = await Promise.all([
    t.client
      .from('branches')
      .select('id, code, name, address, city, country, timezone, currency_code, phone, opening_hours, status, status_reason, is_default, created_at')
      .order('is_default', { ascending: false })
      .order('name'),
    canManage ? t.client.from('portals').select('id, name, status, branch_ids').order('name') : Promise.resolve({ data: [] }),
    loadBranchContext(t.client),
  ]);

  return (
    <div className="space-y-6 max-w-5xl">
      <div>
        <h1 className="text-xl font-black">Branches</h1>
        <p className="text-muted text-xs mt-1 max-w-2xl">
          Every location of {t.config.restaurantName}. Menu, recipes, suppliers and staff are shared; orders, tables, stock movements,
          purchase orders, cash and the day close belong to one branch. Pick the branch you are working in from the selector in
          the menu — the database also limits each login to the branches it is given here.
        </p>
      </div>
      {branchesRes.error ? (
        <div className="rounded-lg border border-border bg-surface p-4 text-xs text-muted">
          Branches are not set up for this restaurant yet: its database is waiting for the multi-branch update.
        </div>
      ) : (
        <BranchesManager
          slug={slug}
          branches={(branchesRes.data ?? []) as ManagedBranch[]}
          logins={((portalsRes.data ?? []) as BranchLogin[])}
          canManage={canManage}
          multiEntitled={ent.isEntitled('branches.multi')}
          currentBranchId={ctx.selectedId}
        />
      )}
    </div>
  );
}
