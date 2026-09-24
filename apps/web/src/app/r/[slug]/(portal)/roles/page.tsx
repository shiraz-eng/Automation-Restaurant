import { notFound, redirect } from 'next/navigation';
import { createTenantServerClient } from '@/lib/supabase/tenant-server';
import { gatePortalPage, can } from '@/lib/permissions';
import { RolesManager, AccessList } from './RolesManager';

export const dynamic = 'force-dynamic';

export default async function RolesPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const t = await createTenantServerClient(slug);
  if (!t) notFound();
  const { role, perms } = await gatePortalPage(t.client, slug, '');
  const canRoles = can(perms, role, 'roles.view');
  const canAccess = can(perms, role, 'permissions.view') || can(perms, role, 'permissions.assign');
  if (!canRoles && !canAccess) redirect(`/r/${slug}`);

  return (
    <div className="space-y-6 max-w-5xl">
      <div>
        <h1 className="text-xl font-black">Roles &amp; access</h1>
        <p className="text-muted text-xs mt-1">
          Role presets decide what each kind of staff member can do. You can only grant permissions you hold yourself.
        </p>
      </div>
      {canRoles && (
        <RolesManager
          canCreate={can(perms, role, 'roles.create')}
          canUpdate={can(perms, role, 'roles.update')}
          canDelete={can(perms, role, 'roles.delete')}
          callerPermissions={role === 'owner' || perms.length === 0 ? ['*'] : perms}
        />
      )}
      {canAccess && <AccessList />}
    </div>
  );
}
