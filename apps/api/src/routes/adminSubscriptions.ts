import express, { type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import { isAllowedOrigin, env } from '../env';
import { supabaseAdmin } from '../supabase';
import { stripe, billingConfigured, priceIdFor } from '../stripe';
import { syncEntitlementsForTenant } from '../lib/entitlementSync';
import { requireSuperAdminPerm } from '../middleware/adminAuth';

/**
 * Admin-initiated subscription actions for an ARBITRARY tenant — the
 * tenant-facing apps/api/src/routes/billing.ts can't be reused as-is
 * because requirePortalPerm validates the bearer token against THAT
 * tenant's own Supabase project, not the control-plane admin session.
 * Mirrors billing.ts's real-Stripe-vs-mock branch exactly.
 */
export const adminSubscriptionsRouter = express.Router();

adminSubscriptionsRouter.use((req: Request, res: Response, next: NextFunction) => {
  const origin = req.headers.origin;
  if (isAllowedOrigin(origin)) {
    res.header('Access-Control-Allow-Origin', origin);
    res.header('Vary', 'Origin');
  }
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return void res.sendStatus(204);
  next();
});

async function loadSub(tenantId: string) {
  const { data } = await supabaseAdmin
    .from('subscriptions')
    .select('stripe_subscription_id, stripe_customer_id, status, tier, billing_interval')
    .eq('tenant_id', tenantId)
    .maybeSingle();
  return data;
}

function isRealStripeSub(subId: string | null | undefined): subId is string {
  return !!billingConfigured && !!subId && !subId.startsWith('mock_sub_');
}

/** POST /api/admin/subscriptions/:tenantId/cancel */
adminSubscriptionsRouter.post(
  '/:tenantId/cancel',
  express.json(),
  requireSuperAdminPerm('subscriptions.manage'),
  async (req: Request, res: Response) => {
    const tenantId = req.params.tenantId ?? '';
    if (!tenantId) return res.status(400).json({ error: 'missing_tenant' });
    const sub = await loadSub(tenantId);
    if (!sub) return res.status(404).json({ error: 'no_subscription' });
    if (sub.status === 'canceled') return res.status(409).json({ error: 'already_canceled' });

    try {
      if (isRealStripeSub(sub.stripe_subscription_id)) {
        const updated = await stripe.subscriptions.update(sub.stripe_subscription_id, { cancel_at_period_end: true });
        return res.json({ ok: true, mode: 'scheduled', cancels_at: updated.current_period_end });
      }
      const { error } = await supabaseAdmin.rpc('cancel_subscription', { p_tenant_id: tenantId });
      if (error) throw new Error(error.message);
      await syncEntitlementsForTenant(tenantId).catch((err) => console.error('[admin-sub] entitlement sync failed:', err));
      res.json({ ok: true, mode: 'immediate' });
    } catch (err) {
      res.status(502).json({ error: 'cancel_failed', message: String((err as Error).message ?? err) });
    }
  },
);

/** POST /api/admin/subscriptions/:tenantId/reactivate */
adminSubscriptionsRouter.post(
  '/:tenantId/reactivate',
  express.json(),
  requireSuperAdminPerm('subscriptions.manage'),
  async (req: Request, res: Response) => {
    const tenantId = req.params.tenantId ?? '';
    if (!tenantId) return res.status(400).json({ error: 'missing_tenant' });
    const sub = await loadSub(tenantId);
    if (!sub) return res.status(404).json({ error: 'no_subscription' });

    try {
      if (isRealStripeSub(sub.stripe_subscription_id)) {
        await stripe.subscriptions.update(sub.stripe_subscription_id, { cancel_at_period_end: false });
      } else {
        const { error } = await supabaseAdmin.rpc('reactivate_subscription', { p_tenant_id: tenantId });
        if (error) throw new Error(error.message);
      }
      await syncEntitlementsForTenant(tenantId).catch((err) => console.error('[admin-sub] entitlement sync failed:', err));
      res.json({ ok: true });
    } catch (err) {
      res.status(502).json({ error: 'reactivate_failed', message: String((err as Error).message ?? err) });
    }
  },
);

const changePlanSchema = z.object({
  tier: z.string().min(1),
  billing_interval: z.enum(['monthly', 'annual']),
});

/** POST /api/admin/subscriptions/:tenantId/change-plan */
adminSubscriptionsRouter.post(
  '/:tenantId/change-plan',
  express.json(),
  requireSuperAdminPerm('subscriptions.manage'),
  async (req: Request, res: Response) => {
    const parsed = changePlanSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(422).json({ error: 'invalid_request', details: parsed.error.flatten().fieldErrors });
    }
    const tenantId = req.params.tenantId ?? '';
    if (!tenantId) return res.status(400).json({ error: 'missing_tenant' });
    const { tier, billing_interval } = parsed.data;
    const sub = await loadSub(tenantId);
    if (!sub) return res.status(404).json({ error: 'no_subscription' });

    try {
      if (isRealStripeSub(sub.stripe_subscription_id)) {
        const priceId = await priceIdFor(tier, billing_interval);
        if (!priceId) return res.status(422).json({ error: 'no_stripe_price', message: `${tier} has no Stripe price configured.` });
        const stripeSub = await stripe.subscriptions.retrieve(sub.stripe_subscription_id);
        const itemId = stripeSub.items.data[0]?.id;
        if (!itemId) return res.status(500).json({ error: 'no_subscription_item' });
        await stripe.subscriptions.update(sub.stripe_subscription_id, {
          items: [{ id: itemId, price: priceId }],
          proration_behavior: 'create_prorations',
        });
      } else {
        const { error } = await supabaseAdmin.rpc('change_subscription_plan', {
          p_tenant_id: tenantId,
          p_tier: tier,
          p_billing_interval: billing_interval,
        });
        if (error) throw new Error(error.message);
      }
      await syncEntitlementsForTenant(tenantId).catch((err) => console.error('[admin-sub] entitlement sync failed:', err));
      res.json({ ok: true });
    } catch (err) {
      res.status(502).json({ error: 'change_plan_failed', message: String((err as Error).message ?? err) });
    }
  },
);

const extendTrialSchema = z.object({ days: z.number().int().min(1).max(365) });

/** POST /api/admin/subscriptions/:tenantId/extend-trial */
adminSubscriptionsRouter.post(
  '/:tenantId/extend-trial',
  express.json(),
  requireSuperAdminPerm('subscriptions.manage'),
  async (req: Request, res: Response) => {
    const parsed = extendTrialSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(422).json({ error: 'invalid_request', details: parsed.error.flatten().fieldErrors });
    }
    const tenantId = req.params.tenantId ?? '';
    if (!tenantId) return res.status(400).json({ error: 'missing_tenant' });
    const sub = await loadSub(tenantId);
    if (!sub) return res.status(404).json({ error: 'no_subscription' });

    try {
      if (isRealStripeSub(sub.stripe_subscription_id)) {
        const stripeSub = await stripe.subscriptions.retrieve(sub.stripe_subscription_id);
        const base = Math.max(stripeSub.trial_end ?? 0, Math.floor(Date.now() / 1000));
        await stripe.subscriptions.update(sub.stripe_subscription_id, {
          trial_end: base + parsed.data.days * 86400,
        });
      } else {
        const { error } = await supabaseAdmin.rpc('extend_trial', { p_tenant_id: tenantId, p_days: parsed.data.days });
        if (error) throw new Error(error.message);
      }
      await syncEntitlementsForTenant(tenantId).catch((err) => console.error('[admin-sub] entitlement sync failed:', err));
      res.json({ ok: true });
    } catch (err) {
      res.status(502).json({ error: 'extend_trial_failed', message: String((err as Error).message ?? err) });
    }
  },
);

/** POST /api/admin/subscriptions/:tenantId/portal-session — Stripe-hosted
 *  Customer Portal for this tenant, opened by an admin on their behalf. */
adminSubscriptionsRouter.post(
  '/:tenantId/portal-session',
  express.json(),
  requireSuperAdminPerm('subscriptions.manage'),
  async (req: Request, res: Response) => {
    if (!billingConfigured) return res.status(503).json({ error: 'billing_not_configured' });
    const tenantId = req.params.tenantId ?? '';
    if (!tenantId) return res.status(400).json({ error: 'missing_tenant' });
    const sub = await loadSub(tenantId);
    if (!sub?.stripe_customer_id) return res.status(422).json({ error: 'no_stripe_customer' });

    try {
      const session = await stripe.billingPortal.sessions.create({
        customer: sub.stripe_customer_id,
        return_url: `${env.APP_URL}/admin/customers`,
      });
      res.json({ ok: true, url: session.url });
    } catch (err) {
      res.status(502).json({ error: 'stripe_error', message: String((err as Error).message ?? err) });
    }
  },
);
