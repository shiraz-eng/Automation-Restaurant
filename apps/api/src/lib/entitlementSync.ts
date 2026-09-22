import { supabaseAdmin } from '../supabase';
import { tenantServiceClient } from './tenantAdmin';
import { getPlanByTier } from './plans';
import { isEntitled, type SubscriptionStatus } from '@automation-restaurant/shared';

/**
 * Pushes a tenant's current plan tier + enforceable features down into its
 * own project's business_settings (0055_plan_entitlements.sql) — the only
 * way that project can enforce its own plan (e.g. the Brand Kit trigger)
 * without a round trip to the control plane on every write. Call this
 * whenever a tenant's tier/status could have changed: the Stripe webhook's
 * subscription-change handler, mock-mode registration, cancellation, and
 * the admin "resync" action below (which also backfills tenants
 * provisioned before this sync existed).
 */
export async function syncEntitlementsForTenant(tenantId: string): Promise<void> {
  const { data: sub } = await supabaseAdmin.from('subscriptions').select('tier, status').eq('tenant_id', tenantId).maybeSingle();
  if (!sub?.tier) return;
  const plan = await getPlanByTier(sub.tier);
  // A canceled/past_due/incomplete subscription keeps its tier on record
  // (so e.g. the Billing page can still say "you were on Professional") but
  // gets NO features — without this, a canceled tenant would keep every
  // entitlement its old tier ever granted, since plan_tier alone doesn't
  // capture status.
  const features = isEntitled(sub.status as SubscriptionStatus) ? (plan?.features ?? []) : [];
  const svc = await tenantServiceClient(tenantId);
  if (!svc) return;
  const { error } = await svc.admin
    .from('business_settings')
    .update({ plan_tier: sub.tier, plan_features: features })
    .eq('id', true);
  // The Supabase client returns { error }, it does not throw — a missed
  // check here would silently report success for a tenant whose 0055
  // migration hasn't actually been applied yet.
  if (error) throw new Error(error.message);
}

/** Re-syncs every active tenant — used to backfill tenants provisioned
 *  before this sync existed, and as a manual "fix drift" action after an
 *  admin edits a plan's feature list (which itself has no automatic
 *  per-tenant push, since it's a direct RLS write from the admin browser,
 *  not a server-side action). */
export async function syncEntitlementsForAllTenants(): Promise<{ synced: number; failed: number }> {
  const { data: tenants } = await supabaseAdmin.from('tenants').select('id').eq('status', 'active');
  let synced = 0;
  let failed = 0;
  for (const t of tenants ?? []) {
    try {
      await syncEntitlementsForTenant(t.id);
      synced++;
    } catch (err) {
      failed++;
      console.error(`[entitlementSync] failed for tenant ${t.id}:`, err);
    }
  }
  return { synced, failed };
}
