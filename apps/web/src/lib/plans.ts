import type { PlanRow } from '@automation-restaurant/shared';

/**
 * Server-side fetch of active plans from GET /api/public/plans — the one
 * place plan/pricing data comes from (public.plans on the control plane,
 * via apps/api/src/lib/plans.ts), replacing the old static PLANS import so
 * every page reflects an admin's edits immediately, not after a deploy.
 */
const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

async function fetchPlans(): Promise<{ plans: PlanRow[]; billingConfigured: boolean }> {
  try {
    const res = await fetch(`${API}/api/public/plans`, { cache: 'no-store' });
    if (!res.ok) return { plans: [], billingConfigured: false };
    const body = (await res.json()) as { plans: PlanRow[]; billing_configured: boolean };
    return { plans: body.plans ?? [], billingConfigured: body.billing_configured ?? false };
  } catch {
    return { plans: [], billingConfigured: false };
  }
}

export async function getActivePlans(): Promise<PlanRow[]> {
  return (await fetchPlans()).plans;
}

export async function getPlanByTier(tier: string): Promise<PlanRow | undefined> {
  const { plans } = await fetchPlans();
  return plans.find((p) => p.tier === tier);
}

export async function isBillingConfigured(): Promise<boolean> {
  return (await fetchPlans()).billingConfigured;
}
