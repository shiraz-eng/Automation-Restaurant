import express, { type Request, type Response, type NextFunction } from 'express';
import { supabaseAdmin } from '../supabase';
import { isAllowedOrigin, env } from '../env';
import { requirePortalPerm } from '../middleware/portalAuth';
import { stripe, billingConfigured } from '../stripe';
import { syncEntitlementsForTenant } from '../lib/entitlementSync';

/**
 * Tenant-facing billing self-service: a Stripe-hosted Customer Portal
 * session (plan changes, cancellation, payment method) and the tenant's
 * own invoice history — both proxy Stripe directly rather than duplicating
 * billing logic or invoice records locally (spec: reuse the payment
 * provider's own billing portal, never build a second billing engine).
 * Owner-only, mirroring the Billing page's own gate (settings.view + role
 * === 'owner') — the UI hiding "Manage billing" from a non-owner is not
 * itself the boundary, this route re-checks it server-side.
 */
export const billingRouter = express.Router();

billingRouter.use((req: Request, res: Response, next: NextFunction) => {
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

async function requireOwner(req: Request, res: Response): Promise<{ tenantId: string } | null> {
  if (req.tenant!.role !== 'owner') {
    res.status(403).json({ error: 'owner_only', message: 'Only the restaurant owner can manage billing.' });
    return null;
  }
  const { data: t } = await supabaseAdmin.from('tenants').select('id').eq('slug', req.tenant!.slug).maybeSingle();
  if (!t) {
    res.status(404).json({ error: 'restaurant_not_found' });
    return null;
  }
  return { tenantId: t.id };
}

/** POST /api/billing/portal-session — a Stripe-hosted Customer Portal
 *  session URL for this tenant's subscription (plan changes, cancellation,
 *  payment method, invoice history are all handled there, not by us). */
billingRouter.post('/portal-session', express.json(), requirePortalPerm('settings.view'), async (req: Request, res: Response) => {
  if (!billingConfigured) {
    return res.status(503).json({ error: 'billing_not_configured', message: 'Billing is not connected to a live payment provider yet.' });
  }
  const ctx = await requireOwner(req, res);
  if (!ctx) return;

  const { data: sub } = await supabaseAdmin
    .from('subscriptions')
    .select('stripe_customer_id')
    .eq('tenant_id', ctx.tenantId)
    .maybeSingle();
  if (!sub?.stripe_customer_id) {
    return res.status(422).json({
      error: 'no_stripe_customer',
      message: 'This restaurant has no billing account on file — it was likely set up before Stripe billing was connected. Contact support to link one.',
    });
  }

  try {
    const session = await stripe.billingPortal.sessions.create({
      customer: sub.stripe_customer_id,
      return_url: `${env.APP_URL}/r/${req.tenant!.slug}/billing`,
    });
    res.json({ ok: true, url: session.url });
  } catch (err) {
    res.status(502).json({ error: 'stripe_error', message: String((err as Error).message ?? err) });
  }
});

/**
 * POST /api/billing/cancel — self-service cancellation. A real Stripe
 * subscription is cancelled at Stripe (cancel_at_period_end — the tenant
 * keeps access through what they already paid for); the actual status flip
 * to 'canceled' arrives later through the existing webhook, same as any
 * other Stripe-driven change (spec: reuse the payment provider's own
 * cancellation, never a second billing engine). A mock-mode subscription
 * has no real Stripe object behind it to cancel, so it's marked canceled
 * immediately via cancel_subscription() (control-plane/0010).
 */
billingRouter.post('/cancel', express.json(), requirePortalPerm('settings.view'), async (req: Request, res: Response) => {
  const ctx = await requireOwner(req, res);
  if (!ctx) return;

  const { data: sub } = await supabaseAdmin
    .from('subscriptions')
    .select('stripe_subscription_id, status')
    .eq('tenant_id', ctx.tenantId)
    .maybeSingle();
  if (!sub) return res.status(404).json({ error: 'no_subscription' });
  if (sub.status === 'canceled') return res.status(409).json({ error: 'already_canceled' });

  const isRealStripeSub = billingConfigured && sub.stripe_subscription_id && !sub.stripe_subscription_id.startsWith('mock_sub_');

  try {
    if (isRealStripeSub) {
      const updated = await stripe.subscriptions.update(sub.stripe_subscription_id as string, { cancel_at_period_end: true });
      return res.json({
        ok: true,
        mode: 'scheduled',
        message: 'Your subscription will cancel at the end of the current billing period — you keep access until then.',
        cancels_at: updated.current_period_end,
      });
    }

    const { error } = await supabaseAdmin.rpc('cancel_subscription', { p_tenant_id: ctx.tenantId });
    if (error) throw new Error(error.message);
    try {
      await syncEntitlementsForTenant(ctx.tenantId);
    } catch (err) {
      console.error(`[billing] entitlement sync failed after cancel for tenant ${ctx.tenantId}:`, err);
    }
    return res.json({ ok: true, mode: 'immediate', message: 'Your subscription has been canceled.' });
  } catch (err) {
    res.status(502).json({ error: 'cancel_failed', message: String((err as Error).message ?? err) });
  }
});

/** GET /api/billing/invoices — this tenant's own Stripe invoices. */
billingRouter.get('/invoices', requirePortalPerm('settings.view'), async (req: Request, res: Response) => {
  if (!billingConfigured) return res.json({ invoices: [] });
  const ctx = await requireOwner(req, res);
  if (!ctx) return;

  const { data: sub } = await supabaseAdmin
    .from('subscriptions')
    .select('stripe_customer_id')
    .eq('tenant_id', ctx.tenantId)
    .maybeSingle();
  if (!sub?.stripe_customer_id) return res.json({ invoices: [] });

  try {
    const invoices = await stripe.invoices.list({ customer: sub.stripe_customer_id, limit: 24 });
    res.json({
      invoices: invoices.data.map((inv) => ({
        id: inv.id,
        status: inv.status,
        amount_due_cents: inv.amount_due,
        amount_paid_cents: inv.amount_paid,
        currency: inv.currency,
        created: inv.created,
        hosted_invoice_url: inv.hosted_invoice_url,
        invoice_pdf: inv.invoice_pdf,
      })),
    });
  } catch (err) {
    res.status(502).json({ error: 'stripe_error', message: String((err as Error).message ?? err) });
  }
});
