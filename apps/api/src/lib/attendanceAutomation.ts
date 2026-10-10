import { supabaseAdmin } from '../supabase';
import { forEachActiveTenant } from './tenantSweep';
import { tenantServiceClient } from './tenantAdmin';

/**
 * Automatic absence marking (tenant-migrations/0053) — the trigger and
 * eligibility are decided entirely in public.attendance_auto_absent_sweep()
 * (SQL); this module just calls it per tenant on an interval, same
 * setInterval-sweep pattern low-stock/recipe-cost automation already use
 * (server.ts). Nothing here uses an AI model. A 3-day lookback (the RPC's
 * default) means a tenant that was unreachable for a tick or two still
 * gets swept correctly on the next one — the underlying insert is
 * idempotent per (membership_id, business_date).
 */
export async function runAttendanceAutoAbsentSweepForTenant(tenantId: string): Promise<number> {
  const svc = await tenantServiceClient(tenantId);
  if (!svc) return 0;
  const { data, error } = await svc.admin.rpc('attendance_auto_absent_sweep');
  if (error) {
    console.error(`[attendance] ${tenantId} attendance_auto_absent_sweep failed:`, error.message);
    return 0;
  }
  return (data as number | null) ?? 0;
}

/** Sweeps every active tenant. One tenant's failure never stops the rest. */
export async function runAttendanceAutoAbsentSweepAllTenants(): Promise<void> {
  await forEachActiveTenant('attendance', async (tenantId, slug) => {
    const marked = await runAttendanceAutoAbsentSweepForTenant(tenantId);
    if (marked > 0) console.log(`[attendance] ${slug}: marked ${marked} absence(s) automatically`);
  });
}
