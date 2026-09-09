import express from 'express';
import { env } from './env';
import { stripeWebhook } from './webhooks/stripe';
import { onboardingRouter } from './routes/onboarding';
import { publicRouter } from './routes/public';
import { staffRouter } from './routes/staff';

const app = express();

app.disable('x-powered-by');

// The Stripe webhook needs the raw body, so it is mounted before any body
// parser. Each other router applies express.json() itself.
app.use('/api/webhooks/stripe', stripeWebhook);
app.use('/api/onboarding', onboardingRouter);
app.use('/api/public', publicRouter);
app.use('/api/staff', staffRouter);

app.get('/health', (_req, res) => res.json({ ok: true }));

app.listen(env.PORT, () => {
  console.log(`api listening on http://localhost:${env.PORT}`);
});
