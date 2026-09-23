import { createControlPlaneServerClient } from '@/lib/supabase/control-plane-server';
import { gateAdminPage } from '@/lib/adminPermissions';
import { CustomersClient } from './CustomersClient';
import { groupByOwner, type SubRow, type PlanLite, type TenantLite } from '@automation-restaurant/shared';

export const dynamic = 'force-dynamic';

type TenantJoined = TenantLite & { restaurant_name: string; subscriptions: SubRow | SubRow[] | null };

function one<T>(x: T | T[] | null): T | null {
  return Array.isArray(x) ? (x[0] ?? null) : x;
}

export default async function AdminCustomersPage() {
  const supabase = await createControlPlaneServerClient();
  await gateAdminPage(supabase, 'customers.view');

  const [{ data: tenants, error }, { data: plans }] = await Promise.all([
    supabase
      .from('tenants')
      .select('id, restaurant_name, owner_email, status, created_at, subscriptions(tier, billing_interval, status, updated_at)'),
    supabase.from('plans').select('tier, name, price_monthly_cents, price_annual_cents'),
  ]);

  const tenantRows = (tenants ?? []) as unknown as TenantJoined[];
  const subsByTenantId = new Map<string, SubRow[]>();
  for (const t of tenantRows) {
    const sub = one(t.subscriptions);
    subsByTenantId.set(t.id, sub ? [sub] : []);
  }
  const customers = groupByOwner(tenantRows, subsByTenantId, (plans ?? []) as PlanLite[]);

  return (
    <div className="space-y-6 max-w-5xl">
      <div>
        <h1 className="text-xl font-black">Customers</h1>
        <p className="text-ink-muted text-xs mt-1">Grouped by owner — one customer can own several restaurants.</p>
      </div>

      {error && (
        <div className="rounded-lg border border-red-500/40 bg-red-500/10 text-red-400 p-4 text-xs">{error.message}</div>
      )}

      <CustomersClient customers={customers} />
    </div>
  );
}
