import { supabaseAdmin } from '../supabase';
import { tenantServiceClient } from './tenantAdmin';

/**
 * Recipe Management's cost-change detection sweep (spec §24, §35 — "an
 * ingredient price change alone, with no recipe edit, should still surface
 * as a tracked cost change"). The actual detection and logging happens
 * entirely in SQL (public.snapshot_recipe_cost_changes(), schema v30) —
 * this just calls it per tenant on a schedule and logs what moved, the
 * same shape as the low-stock sweep.
 */

type CostChange = {
  recipe_id: string;
  recipe_version_id: string;
  previous_cost_cents: number | null;
  new_cost_cents: number;
};

/** Runs the sweep for one tenant. Returns the changes it found (if any). */
export async function runRecipeCostSweepForTenant(tenantId: string): Promise<CostChange[]> {
  const svc = await tenantServiceClient(tenantId);
  if (!svc) return [];
  const { admin } = svc;

  const { data, error } = await admin.rpc('snapshot_recipe_cost_changes');
  if (error) {
    console.error(`[recipe-cost] ${tenantId} snapshot_recipe_cost_changes failed:`, error.message);
    return [];
  }
  return (data ?? []) as CostChange[];
}

/** Sweeps every active tenant. One tenant's failure never stops the rest. */
export async function runRecipeCostSweepAllTenants(): Promise<void> {
  const { data: rows } = await supabaseAdmin.from('tenants').select('id, slug').eq('status', 'active');
  for (const t of (rows ?? []) as { id: string; slug: string }[]) {
    try {
      const changes = await runRecipeCostSweepForTenant(t.id);
      // A change on the FIRST-EVER snapshot (previous_cost_cents null) just
      // means "recipe cost logging started" — only a genuine delta from a
      // prior logged value is worth a log line.
      const genuine = changes.filter((c) => c.previous_cost_cents !== null);
      if (genuine.length > 0) {
        console.log(`[recipe-cost] ${t.slug}: ${genuine.length} recipe(s) changed cost`, genuine);
      }
    } catch (err) {
      console.error(`[recipe-cost] sweep error for ${t.slug}:`, err);
    }
  }
}
