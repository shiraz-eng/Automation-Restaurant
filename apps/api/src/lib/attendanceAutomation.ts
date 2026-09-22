import { supabaseAdmin } from '../supabase';
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
  const { data: rows } = await supabaseAdmin.from('tenants').select('id, slug').eq('status', 'active');
  for (const t of (rows ?? []) as { id: string; slug: string }[]) {
    try {
      const marked = await runAttendanceAutoAbsentSweepForTenant(t.id);
      if (marked > 0) console.log(`[attendance] ${t.slug}: marked ${marked} absence(s) automatically`);
    } catch (err) {
      console.error(`[attendance] sweep error for ${t.slug}:`, err);
    }
  }
}
