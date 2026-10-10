import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { createTenantServerClient } from '@/lib/supabase/tenant-server';
import { gatePortalPage, can } from '@/lib/permissions';
import { getTenantEntitlement } from '@/lib/entitlements';
import { loadBranchContext } from '@/lib/branchServer';
import { BranchesManager, type ManagedBranch, type BranchLogin } from './BranchesManager';
import { BranchMenuPrices, type MenuRow, type OverrideRow } from './BranchMenuPrices';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Branches' };

export default async function BranchesPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const t = await createTenantServerClient(slug);
  if (!t) notFound();
  const { role, perms } = await gatePortalPage(t.client, slug, 'branches.view');
  const ent = await getTenantEntitlement(t.client, t.config.tier);
  const canManage = can(perms, role, 'branches.manage');
  const canPrice = canManage || can(perms, role, 'menu.update');

  const [branchesRes, portalsRes, ctx, menuRes, overridesRes, membersRes] = await Promise.all([
    t.client
      .from('branches')
      .select('id, code, name, address, city, country, timezone, currency_code, phone, opening_hours, status, status_reason, is_default, created_at')
      .order('is_default', { ascending: false })
      .order('name'),
    canManage ? t.client.from('portals').select('id, name, status, branch_ids').order('name') : Promise.resolve({ data: [] }),
    loadBranchContext(t.client),
    canPrice ? t.client.from('menu_items').select('id, name, menu_variants(id, name, price_cents)').order('name') : Promise.resolve({ data: [] }),
    canPrice ? t.client.from('branch_menu_overrides').select('branch_id, menu_item_id, variant_id, price_cents, is_available') : Promise.resolve({ data: [] }),
    // Staff logins (not the owner, who always sees every branch).
    canManage
      ? t.client.from('memberships').select('id, full_name, email, role, status, branch_ids').neq('role', 'owner').order('full_name')
      : Promise.resolve({ data: [] }),
  ]);
  const logins: BranchLogin[] = [
    ...((portalsRes.data ?? []) as Omit<BranchLogin, 'kind'>[]).map((p) => ({ ...p, kind: 'portal' as const })),
    ...((membersRes.data ?? []) as { id: string; full_name: string | null; email: string; role: string; status: string; branch_ids: string[] | null }[]).map(
      (m) => ({ id: m.id, name: m.full_name || m.email, status: m.status, branch_ids: m.branch_ids, kind: 'member' as const, detail: m.role }),
    ),
  ];

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
          logins={logins}
          canManage={canManage}
          multiEntitled={ent.isEntitled('branches.multi')}
          currentBranchId={ctx.selectedId}
        />
      )}
      {!branchesRes.error && canPrice && (
        <BranchMenuPrices
          branches={(branchesRes.data ?? []) as ManagedBranch[]}
          items={(menuRes.data ?? []) as MenuRow[]}
          overrides={(overridesRes.data ?? []) as OverrideRow[]}
        />
      )}
    </div>
  );
}
