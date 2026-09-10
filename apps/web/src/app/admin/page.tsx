import { redirect } from 'next/navigation';
import { createControlPlaneServerClient } from '@/lib/supabase/control-plane-server';
import { StatCard } from '@/components/StatCard';
import { AdminClient, type TenantRow } from './AdminClient';

export const dynamic = 'force-dynamic';

export default async function AdminDashboard() {
  const supabase = await createControlPlaneServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user || (user.app_metadata as { role?: string }).role !== 'super_admin') {
    redirect('/admin/login');
  }

  const { data, error } = await supabase
    .from('tenants')
    .select(
      'id, restaurant_name, slug, status, owner_email, region, provisioning_error, welcome_email_status, welcome_email_error, provisioning_attempts, created_at, subscriptions(tier, status, billing_interval), tenant_projects(project_ref, project_url)',
    )
    .order('created_at', { ascending: false });

  const rows = (data ?? []) as unknown as TenantRow[];
  const active = rows.filter((r) => r.status === 'active').length;
  const provisioning = rows.filter((r) => r.status === 'provisioning').length;
  const failed = rows.filter((r) => r.status === 'failed').length;

  return (
    <div className="space-y-8 max-w-5xl">
      <h1 className="text-xl font-black">Restaurants</h1>

      {error && (
        <div className="rounded-lg border border-danger/40 bg-danger/10 text-danger p-4 text-xs">
          {error.message}
        </div>
      )}

      <section className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard label="Total" value={rows.length} />
        <StatCard label="Active" value={active} tone="ok" />
        <StatCard label="Provisioning" value={provisioning} tone={provisioning ? 'warn' : 'default'} />
        <StatCard label="Failed" value={failed} tone={failed ? 'danger' : 'default'} />
      </section>

      <AdminClient rows={rows} />
    </div>
  );
}
