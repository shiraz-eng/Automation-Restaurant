import { notFound } from 'next/navigation';
import { createTenantServerClient } from '@/lib/supabase/tenant-server';
import { gatePortalPage, can } from '@/lib/permissions';
import { RolesManager, type Role, type PermRow } from './RolesManager';

export const dynamic = 'force-dynamic';

export default async function RolesPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const t = await createTenantServerClient(slug);
  if (!t) notFound();

  const { role, perms } = await gatePortalPage(t.client, slug, 'roles.view', { ownerOnly: true });
  const canEdit = can(perms, role, 'roles.update');

  const [{ data: roles, error }, { data: catalog }] = await Promise.all([
    t.client
      .from('roles')
      .select('id, key, name, permissions, is_system')
      .order('is_system', { ascending: false })
      .order('name'),
    t.client.from('permission_catalog').select('key, grp, label').order('grp').order('key'),
  ]);

  return (
    <div className="space-y-6 max-w-3xl">
      <div>
        <h1 className="text-xl font-black">Roles & Access Control</h1>
        <p className="text-muted text-xs mt-1">
          Named permission presets — toggle a whole portal/domain at once, or fine-tune individual
          permissions below it. A staff member&apos;s effective access is their role&apos;s
          permissions plus any extra grants, enforced server-side (RLS) regardless of what this
          screen shows — never just hidden navigation. Owner-only capabilities (unrestricted
          access, Roles & Access Control itself, Kiosk Portals, Billing, Policies) can never be
          granted to another role from here.
        </p>
      </div>

      {error ? (
        <div className="rounded-lg border border-danger/40 bg-danger/10 text-danger p-4 text-xs">
          {error.message}
        </div>
      ) : (
        <RolesManager
          roles={(roles ?? []) as Role[]}
          catalog={(catalog ?? []) as PermRow[]}
          canEdit={canEdit}
        />
      )}
    </div>
  );
}
