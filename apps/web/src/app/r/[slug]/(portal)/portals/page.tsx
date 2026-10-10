import { notFound } from 'next/navigation';
import { createTenantServerClient } from '@/lib/supabase/tenant-server';
import { gatePortalPage } from '@/lib/permissions';
import { PlanUpgradePaywall } from '@/components/PlanUpgradePaywall';
import { getTenantEntitlement } from '@/lib/entitlements';
import { loadBranchContext } from '@/lib/branchServer';
import {
  PortalsManager,
  type Portal,
  type PermRow,
} from './PortalsManager';

export const dynamic = 'force-dynamic';

export default async function PortalsPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ branch?: string }>;
}) {
  const { slug } = await params;
  const { branch: startForBranch } = await searchParams;
  const t = await createTenantServerClient(slug);
  if (!t) notFound();

  await gatePortalPage(t.client, slug, 'portals.view', { ownerOnly: true });

  const ent = await getTenantEntitlement(t.client, t.config.tier);
  if (!ent.isEntitled('portals.advanced')) {
    return <PlanUpgradePaywall slug={slug} featureKey="portals.advanced" currentTier={ent.tier} />;
  }

  const [{ data: portals, error }, permsRes, { data: brandKitRows }] = await Promise.all([
    t.client
      .from('portals')
      .select('id, name, type, route_key, status, permissions, email, last_login_at, last_logout_at, created_at')
      .order('created_at'),
    t.client.from('permission_catalog').select('key, grp, label, type, risk_level').order('grp'),
    t.client.rpc('get_brand_kit'),
  ]);
  // A tenant that hasn't received 0057 yet has no type/risk_level columns —
  // fall back to the base columns so the checkbox list still works (just
  // without type/risk badges) instead of rendering no permissions at all.
  let perms = permsRes.data as PermRow[] | null;
  if (permsRes.error) {
    const { data: basic } = await t.client.from('permission_catalog').select('key, grp, label').order('grp');
    perms = ((basic ?? []) as { key: string; grp: string; label: string }[]).map((p) => ({ ...p, type: null, risk_level: null }));
  }
  // Multi-branch: which branches each portal works in (a separate read, so restaurants
  // before migration 0098 — no branch_ids column — still list their portals).
  const branchCtx = await loadBranchContext(t.client);
  const { data: portalBranches } = branchCtx.multi
    ? await t.client.from('portals').select('id, branch_ids')
    : { data: [] };
  const branchesOf = new Map(((portalBranches ?? []) as { id: string; branch_ids: string[] | null }[]).map((p) => [p.id, p.branch_ids ?? []]));
  const brandKit = Array.isArray(brandKitRows) ? brandKitRows[0] : brandKitRows;
  const logoUrl: string | null = (brandKit as { logo_url?: string | null } | null)?.logo_url ?? null;

  return (
    <div className="space-y-6 max-w-7xl">
      <div>
        <h1 className="text-xl font-black">Portals</h1>
        <p className="text-muted text-xs mt-1">
          Create purpose-built workspaces — each gets its own login, its own individually
          selected permissions, and its own URL. The Super Admin portal has full control and
          can&rsquo;t be changed.
        </p>
      </div>
      {error ? (
        <div className="rounded-lg border border-danger/40 bg-danger/10 text-danger p-4 text-xs">
          {error.message}
        </div>
      ) : (
        <PortalsManager
          slug={slug}
          restaurantName={t.config.restaurantName}
          logoUrl={logoUrl}
          portals={((portals ?? []) as Portal[]).map((p) => ({ ...p, branch_ids: branchesOf.get(p.id) ?? [] }))}
          perms={perms ?? []}
          branches={branchCtx.multi ? branchCtx.branches.map((b) => ({ id: b.id, code: b.code, name: b.name })) : []}
          startForBranch={typeof startForBranch === 'string' ? startForBranch : null}
        />
      )}
    </div>
  );
}
