import express from 'express';
import { stripeWebhook } from './webhooks/stripe';
import { onboardingRouter } from './routes/onboarding';
import { publicRouter } from './routes/public';
import { customerAiRouter } from './routes/customerAi';
import { staffRouter } from './routes/staff';
import { adminRouter } from './routes/admin';
import { adminUsersRouter } from './routes/adminUsers';
import { adminSubscriptionsRouter } from './routes/adminSubscriptions';
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
import { guideAiPublicRouter, guideAiAuthRouter } from './routes/guideAi';
import { cronRouter } from './routes/cron';

/**
 * The Express app itself — no .listen(), no background sweeps. Shared by
 * two entry points: server.ts (traditional long-running host: local dev,
 * Railway/Render/Fly — .listen() + the periodic sweeps that need a
 * persistent process) and api/[...slug].ts (Vercel serverless — one
 * request in, one response out, no background timers survive between
 * invocations there).
 */
export const app = express();

app.disable('x-powered-by');

// The Stripe webhook needs the raw body, so it is mounted before any body
// parser. Each other router applies express.json() itself.
app.use('/api/webhooks/stripe', stripeWebhook);
app.use('/api/onboarding', onboardingRouter);
app.use('/api/public', publicRouter);
app.use('/api/public', customerAiRouter);
app.use('/api/public', guideAiPublicRouter);
app.use('/api/staff', staffRouter);
app.use('/api/admin', adminRouter);
app.use('/api/admin/team', adminUsersRouter);
app.use('/api/admin/subscriptions', adminSubscriptionsRouter);
app.use('/api/billing', billingRouter);
app.use('/api/saas-ai', saasAiRouter);
app.use('/api/guide-ai', guideAiAuthRouter);
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
app.use('/api/cron', cronRouter);

app.get('/health', (_req, res) => res.json({ ok: true }));
