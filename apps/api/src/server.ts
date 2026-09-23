import { app } from './app';
import { env } from './env';
import { retryFailedProvisions } from './provisioning';
import { runLowStockSweepAllTenants } from './lib/lowStockAutomation';
import { runRecipeCostSweepAllTenants } from './lib/recipeAutomation';
import { runAttendanceAutoAbsentSweepAllTenants } from './lib/attendanceAutomation';

/**
 * Traditional long-running entry point — local dev, or any persistent host
 * (not Vercel: its serverless entry is api/[...slug].ts, which imports the
 * same `app` but never runs these background sweeps).
 */
app.listen(env.PORT, () => {
  console.log(`api listening on http://localhost:${env.PORT}`);
});

// Server-side retry sweep for tenants whose provisioning failed after a
// successful payment. Bounded per-tenant attempts live in provisionTenant.
const RETRY_INTERVAL_MS = 5 * 60_000;
setInterval(() => {
  retryFailedProvisions().catch((err) => console.error('[provision] retry sweep error:', err));
}, RETRY_INTERVAL_MS).unref();

// AI Management's low-stock supplier email sweep (deterministic — the
// trigger and eligibility are decided in SQL, this just sends). Off by
// default per-restaurant (purchasing_settings.low_stock_email_enabled),
// so this interval running is harmless until an owner opts in.
const LOW_STOCK_SWEEP_INTERVAL_MS = 15 * 60_000;
setInterval(() => {
  runLowStockSweepAllTenants().catch((err) => console.error('[low-stock] sweep error:', err));
}, LOW_STOCK_SWEEP_INTERVAL_MS).unref();

// Recipe Management's cost-change detection sweep (spec §24, §35) — logs a
// recipe_cost_log row whenever an active recipe's computed cost has moved
// since it was last recorded, so a supplier price change alone (no recipe
// edit) still shows up in cost history / AI Management's attention items.
const RECIPE_COST_SWEEP_INTERVAL_MS = 15 * 60_000;
setInterval(() => {
  runRecipeCostSweepAllTenants().catch((err) => console.error('[recipe-cost] sweep error:', err));
}, RECIPE_COST_SWEEP_INTERVAL_MS).unref();

// Automatic absence marking (tenant-migrations/0053) — for any past
// business day a staff member was expected in (an explicit shift, or
// their own default shift_start_time on a normal working day) and never
// clocked in or got an explicit status, marks them 'absent' (source=
// 'auto'). Runs less often than the others since it only ever affects
// already-closed business days, never the current one.
const ATTENDANCE_AUTO_ABSENT_SWEEP_INTERVAL_MS = 60 * 60_000;
setInterval(() => {
  runAttendanceAutoAbsentSweepAllTenants().catch((err) => console.error('[attendance] sweep error:', err));
}, ATTENDANCE_AUTO_ABSENT_SWEEP_INTERVAL_MS).unref();
