import { notFound } from 'next/navigation';
import { createTenantServerClient } from '@/lib/supabase/tenant-server';
import { gatePortalPage } from '@/lib/permissions';
import {
  PortalsManager,
  type Portal,
  type PermRow,
  type StaffMember,
  type PortalStaffLink,
} from './PortalsManager';

export const dynamic = 'force-dynamic';

export default async function PortalsPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const t = await createTenantServerClient(slug);
  if (!t) notFound();

  await gatePortalPage(t.client, slug, 'portals.view', { ownerOnly: true });

  const [{ data: portals, error }, permsRes, { data: staff }, { data: links }, { data: brandKitRows }] = await Promise.all([
    t.client
      .from('portals')
      .select('id, name, type, route_key, status, permissions, email, last_login_at, last_logout_at, created_at')
      .order('created_at'),
    t.client.from('permission_catalog').select('key, grp, label, type, risk_level').order('grp'),
    t.client.from('memberships').select('id, email, full_name, role, status').order('email'),
    t.client.from('portal_staff').select('portal_id, membership_id'),
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
          portals={(portals ?? []) as Portal[]}
          perms={perms ?? []}
          staff={(staff ?? []) as StaffMember[]}
          links={(links ?? []) as PortalStaffLink[]}
        />
      )}
    </div>
  );
}
