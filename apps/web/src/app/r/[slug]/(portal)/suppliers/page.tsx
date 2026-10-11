import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { createTenantServerClient } from '@/lib/supabase/tenant-server';
import { gatePortalPage, can } from '@/lib/permissions';
import { SectionReportButtons } from '@/components/SectionReportButtons';
import { PlanUpgradePaywall } from '@/components/PlanUpgradePaywall';
import { getTenantEntitlement } from '@/lib/entitlements';
import { SuppliersManager, type Supplier } from './SuppliersManager';
import { loadBranchContext } from '@/lib/branchServer';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Suppliers' };

export default async function SuppliersPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const t = await createTenantServerClient(slug);
  if (!t) notFound();

  const { role, perms } = await gatePortalPage(t.client, slug, 'supplier.view');

  const ent = await getTenantEntitlement(t.client, t.config.tier);
  if (!ent.isEntitled('inventory.recipe_deduction')) {
    return <PlanUpgradePaywall slug={slug} featureKey="inventory.recipe_deduction" currentTier={ent.tier} />;
  }

  const { data, error } = await t.client
    .from('suppliers')
    .select(
      'id, name, contact_name, email, phone, address, payment_terms, notes, created_at, currency, credit_period_days, preferred_payment_method, is_active',
    )
    .order('name');

  // Multi-branch (0105): label shared vs a branch's own suppliers; a branch login can't change
  // a shared one. A separate read, so restaurants before 0105 (no column) list as before.
  const branchCtx = await loadBranchContext(t.client);
  const { data: limitedRaw } = await t.client.rpc('my_branch_limited');
  const branchLimited = limitedRaw === true;
  let suppliers = (data ?? []) as Supplier[];
  if (branchCtx.multi || branchLimited) {
    const { data: rows } = await t.client.from('suppliers').select('id, branch_id');
    const branchOf = new Map(((rows ?? []) as { id: string; branch_id: string | null }[]).map((r) => [r.id, r.branch_id]));
    const label = new Map(branchCtx.branches.map((b) => [b.id, b.code]));
    suppliers = suppliers.map((s) => {
      const b = branchOf.get(s.id) ?? null;
      return { ...s, branch_label: b ? (label.get(b) ?? 'Branch') : 'Shared', locked: branchLimited && !b };
    });
  }

  return (
    <div className="space-y-6 max-w-4xl">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-black">Suppliers</h1>
          <p className="text-muted text-xs mt-1">
            Vendors you raise purchase orders against. Receiving a PO adds its quantities to
            inventory. With several branches, the owner&apos;s suppliers are shared by all; a supplier a
            branch adds is that branch&apos;s own.
          </p>
        </div>
        <SectionReportButtons slug={slug} restaurantName={t.config.restaurantName} domain="suppliers" label="Suppliers" />
      </div>
      {error ? (
        <div className="rounded-lg border border-danger/40 bg-danger/10 text-danger p-4 text-xs">
          {error.message}
        </div>
      ) : (
        <SuppliersManager
          suppliers={suppliers}
          canManage={can(perms, role, 'supplier.manage')}
          canCreate={can(perms, role, 'supplier.manage') || can(perms, role, 'supplier.create')}
          canEdit={can(perms, role, 'supplier.manage') || can(perms, role, 'supplier.update')}
        />
      )}
    </div>
  );
}
