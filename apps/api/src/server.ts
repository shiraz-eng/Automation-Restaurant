import express from 'express';
import { env } from './env';
import { stripeWebhook } from './webhooks/stripe';
import { onboardingRouter } from './routes/onboarding';
import { publicRouter } from './routes/public';
import { customerAiRouter } from './routes/customerAi';
import { staffRouter } from './routes/staff';
import { adminRouter } from './routes/admin';
import { adminUsersRouter } from './routes/adminUsers';
import { billingRouter } from './routes/billing';
import { saasAiRouter } from './routes/saasAi';
import { portalsRouter } from './routes/portals';
import { aiRouter } from './routes/ai';
import { menuImportRouter } from './routes/menuImport';
import { inventoryImportRouter } from './routes/inventoryImport';
import { recipeImportRouter } from './routes/recipeImport';
import { tableImportRouter } from './routes/tableImport';
import { supplierImportRouter } from './routes/supplierImport';
import { supplierPriceImportRouter } from './routes/supplierPriceImport';
import { poImportRouter } from './routes/poImport';
import { staffImportRouter } from './routes/staffImport';
import { importClassifyRouter } from './routes/importClassify';
import { socialRouter } from './routes/social';
import { retryFailedProvisions } from './provisioning';
import { runLowStockSweepAllTenants } from './lib/lowStockAutomation';
import { runRecipeCostSweepAllTenants } from './lib/recipeAutomation';
import { runAttendanceAutoAbsentSweepAllTenants } from './lib/attendanceAutomation';

const app = express();

app.disable('x-powered-by');

// The Stripe webhook needs the raw body, so it is mounted before any body
// parser. Each other router applies express.json() itself.
app.use('/api/webhooks/stripe', stripeWebhook);
app.use('/api/onboarding', onboardingRouter);
app.use('/api/public', publicRouter);
app.use('/api/public', customerAiRouter);
app.use('/api/staff', staffRouter);
app.use('/api/admin', adminRouter);
app.use('/api/admin/team', adminUsersRouter);
app.use('/api/billing', billingRouter);
app.use('/api/saas-ai', saasAiRouter);
app.use('/api/portals', portalsRouter);
app.use('/api/ai', aiRouter);
app.use('/api/ai', menuImportRouter);
app.use('/api/ai', inventoryImportRouter);
app.use('/api/ai', recipeImportRouter);
app.use('/api/ai', tableImportRouter);
app.use('/api/ai', supplierImportRouter);
app.use('/api/ai', supplierPriceImportRouter);
app.use('/api/ai', poImportRouter);
app.use('/api/ai', staffImportRouter);
app.use('/api/ai', importClassifyRouter);
app.use('/api/social', socialRouter);

app.get('/health', (_req, res) => res.json({ ok: true }));

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
