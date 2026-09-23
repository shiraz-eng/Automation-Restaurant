import Link from 'next/link';
import { createControlPlaneServerClient } from '@/lib/supabase/control-plane-server';
import { gateAdminPage } from '@/lib/adminPermissions';
import { AdminCard } from '../_components/ui';

export const dynamic = 'force-dynamic';

export default async function AdminSettingsPage() {
  const supabase = await createControlPlaneServerClient();
  await gateAdminPage(supabase, 'settings.manage');

  return (
    <div className="space-y-6 max-w-2xl">
      <div>
        <h1 className="text-xl font-black">Settings</h1>
        <p className="text-ink-muted text-xs mt-1">Platform configuration and operational tools.</p>
      </div>

      <Link href="/admin/settings/audit-logs">
        <AdminCard className="hover:bg-white/5 transition-colors">
          <div className="font-bold text-sm">Audit log</div>
          <div className="text-ink-muted text-xs mt-1">Every platform-level change — restaurants, subscriptions, plans, CMS, admin access.</div>
        </AdminCard>
      </Link>

      <Link href="/admin/settings/messages">
        <AdminCard className="hover:bg-white/5 transition-colors">
          <div className="font-bold text-sm">Contact messages</div>
          <div className="text-ink-muted text-xs mt-1">Submissions from the public site's contact form.</div>
        </AdminCard>
      </Link>

      <Link href="/admin/users">
        <AdminCard className="hover:bg-white/5 transition-colors">
          <div className="font-bold text-sm">Platform users</div>
          <div className="text-ink-muted text-xs mt-1">Manage who has admin access and what they can do.</div>
        </AdminCard>
      </Link>
    </div>
  );
}
