import { createControlPlaneServerClient } from '@/lib/supabase/control-plane-server';
import { gateAdminPage } from '@/lib/adminPermissions';
import { RestaurantsClient, type TenantRow } from './RestaurantsClient';

export const dynamic = 'force-dynamic';

export default async function AdminRestaurantsPage() {
  const supabase = await createControlPlaneServerClient();
  const { role, perms } = await gateAdminPage(supabase, 'restaurants.view');

  const [{ data, error }, { data: plans }] = await Promise.all([
    supabase
      .from('tenants')
      .select(
        'id, restaurant_name, slug, status, owner_email, provisioning_error, welcome_email_status, welcome_email_error, provisioning_attempts, created_at, subscriptions(tier, status, billing_interval, current_period_end, stripe_customer_id), tenant_projects(project_ref, project_url)',
      )
      .order('created_at', { ascending: false }),
    supabase.from('plans').select('tier, name, price_monthly_cents, price_annual_cents'),
  ]);

  const rows = (data ?? []) as unknown as TenantRow[];
  const active = rows.filter((r) => r.status === 'active').length;
  const provisioning = rows.filter((r) => r.status === 'provisioning').length;
  const failed = rows.filter((r) => r.status === 'failed').length;

  return (
    <div className="space-y-6 max-w-6xl">
      <div>
        <h1 className="text-xl font-black">Restaurants</h1>
        <p className="text-ink-muted text-xs mt-1">
          {rows.length} total · {active} active · {provisioning} provisioning · {failed} failed
        </p>
      </div>

      {error && (
        <div className="rounded-lg border border-red-500/40 bg-red-500/10 text-red-400 p-4 text-xs">{error.message}</div>
      )}

      <RestaurantsClient rows={rows} plans={plans ?? []} role={role} perms={perms} />
    </div>
  );
}
