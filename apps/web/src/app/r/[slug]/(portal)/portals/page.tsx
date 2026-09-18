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

  const [{ data: portals, error }, { data: perms }, { data: staff }, { data: links }] = await Promise.all([
    t.client
      .from('portals')
      .select('id, name, type, route_key, status, permissions, last_login_at, created_at')
      .order('created_at'),
    t.client.from('permission_catalog').select('key, grp, label').order('grp'),
    t.client.from('memberships').select('id, email, full_name, role, status').order('email'),
    t.client.from('portal_staff').select('portal_id, membership_id'),
  ]);

  return (
    <div className="space-y-6 max-w-4xl">
      <div>
        <h1 className="text-xl font-black">Portal Management</h1>
        <p className="text-muted text-xs mt-1">
          Create purpose-built portals — each gets its own login, its own permissions, and its
          own URL. The Super Admin portal has full control and can&rsquo;t be changed.
        </p>
      </div>
      {error ? (
        <div className="rounded-lg border border-danger/40 bg-danger/10 text-danger p-4 text-xs">
          {error.message}
        </div>
      ) : (
        <PortalsManager
          slug={slug}
          portals={(portals ?? []) as Portal[]}
          perms={(perms ?? []) as PermRow[]}
          staff={(staff ?? []) as StaffMember[]}
          links={(links ?? []) as PortalStaffLink[]}
        />
      )}
    </div>
  );
}
