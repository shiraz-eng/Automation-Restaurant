import { createControlPlaneServerClient } from '@/lib/supabase/control-plane-server';
import { gateAdminPage } from '@/lib/adminPermissions';
import { TeamManager } from './TeamManager';

export const dynamic = 'force-dynamic';

export default async function AdminUsersPage() {
  const supabase = await createControlPlaneServerClient();
  await gateAdminPage(supabase, 'users.manage');

  return (
    <div className="space-y-6 max-w-3xl">
      <div>
        <h1 className="text-xl font-black">Platform Users</h1>
        <p className="text-ink-muted text-xs mt-1">Who has access to this admin panel, and what they can do.</p>
      </div>
      <TeamManager />
    </div>
  );
}
