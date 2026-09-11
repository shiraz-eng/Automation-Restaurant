import express from 'express';
import { env } from './env';
import { stripeWebhook } from './webhooks/stripe';
import { onboardingRouter } from './routes/onboarding';
import { publicRouter } from './routes/public';
import { staffRouter } from './routes/staff';
import { adminRouter } from './routes/admin';
import { portalsRouter } from './routes/portals';
import { aiRouter } from './routes/ai';
import { retryFailedProvisions } from './provisioning';

const app = express();

app.disable('x-powered-by');

// The Stripe webhook needs the raw body, so it is mounted before any body
// parser. Each other router applies express.json() itself.
app.use('/api/webhooks/stripe', stripeWebhook);
app.use('/api/onboarding', onboardingRouter);
app.use('/api/public', publicRouter);
app.use('/api/staff', staffRouter);
app.use('/api/admin', adminRouter);
app.use('/api/portals', portalsRouter);
app.use('/api/ai', aiRouter);

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
