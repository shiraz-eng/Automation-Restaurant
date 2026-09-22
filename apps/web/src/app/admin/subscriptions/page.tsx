import { createControlPlaneServerClient } from '@/lib/supabase/control-plane-server';
import { gateAdminPage } from '@/lib/adminPermissions';
import { AdminCard } from '../_components/ui';

export const dynamic = 'force-dynamic';

const STATUS_TONE: Record<string, string> = {
  active: 'text-emerald-400',
  trialing: 'text-emerald-400',
  past_due: 'text-gold',
  canceled: 'text-red-400',
  incomplete: 'text-ink-muted',
};

type Row = {
  id: string;
  tier: string;
  billing_interval: string;
  status: string;
  current_period_end: string | null;
  updated_at: string;
  tenants: { restaurant_name: string; slug: string } | { restaurant_name: string; slug: string }[] | null;
};

function one<T>(x: T | T[] | null): T | null {
  return Array.isArray(x) ? (x[0] ?? null) : x;
}

/**
 * Read-only by design — subscription state is Stripe/webhook-driven
 * (sync_subscription), same as the RLS on this table itself only grants
 * super_admin SELECT, never UPDATE. Changing a plan happens through Stripe
 * (the tenant's own Billing page) or the payment provider's dashboard, not
 * a raw row edit here — that would let this table drift from what Stripe
 * actually thinks is true.
 */
export default async function AdminSubscriptionsPage() {
  const supabase = await createControlPlaneServerClient();
  await gateAdminPage(supabase, 'subscriptions.view');

  const { data, error } = await supabase
    .from('subscriptions')
    .select('id, tier, billing_interval, status, current_period_end, updated_at, tenants(restaurant_name, slug)')
    .order('updated_at', { ascending: false });

  const rows = (data ?? []) as unknown as Row[];

  return (
    <div className="space-y-6 max-w-5xl">
      <div>
        <h1 className="text-xl font-black">Subscriptions</h1>
        <p className="text-ink-muted text-xs mt-1">
          Read-only — subscription state is driven by the payment provider's webhooks, not edited here.
        </p>
      </div>

      {error && (
        <div className="rounded-lg border border-red-500/40 bg-red-500/10 text-red-400 p-4 text-xs">{error.message}</div>
      )}

      <AdminCard className="overflow-x-auto">
        {rows.length === 0 ? (
          <p className="text-ink-muted text-xs">No subscriptions yet.</p>
        ) : (
          <table className="w-full text-left text-xs">
            <thead className="text-ink-muted">
              <tr className="border-b border-white/10">
                <th className="pb-2 font-semibold">Restaurant</th>
                <th className="pb-2 font-semibold">Tier</th>
                <th className="pb-2 font-semibold">Interval</th>
                <th className="pb-2 font-semibold">Status</th>
                <th className="pb-2 font-semibold">Renews</th>
                <th className="pb-2 font-semibold">Updated</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const t = one(r.tenants);
                return (
                  <tr key={r.id} className="border-b border-white/10 last:border-0">
                    <td className="py-2 font-semibold">{t?.restaurant_name ?? '—'}</td>
                    <td className="py-2 font-mono">{r.tier}</td>
                    <td className="py-2 capitalize">{r.billing_interval}</td>
                    <td className={`py-2 font-semibold capitalize ${STATUS_TONE[r.status] ?? ''}`}>{r.status.replace('_', ' ')}</td>
                    <td className="py-2 text-ink-muted">{r.current_period_end ? new Date(r.current_period_end).toLocaleDateString() : '—'}</td>
                    <td className="py-2 text-ink-muted">{new Date(r.updated_at).toLocaleDateString()}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </AdminCard>
    </div>
  );
}
