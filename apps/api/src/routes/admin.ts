import express, { type Request, type Response, type NextFunction } from 'express';
import { supabaseAdmin } from '../supabase';
import { isAllowedOrigin, env } from '../env';
import { provisionTenant, resendWelcomeEmail } from '../provisioning';
import { stripe } from '../stripe';
import { syncEntitlementsForAllTenants } from '../lib/entitlementSync';
import { requireSuperAdminPerm } from '../middleware/adminAuth';
import { tenantServiceClientBySlug } from '../lib/tenantAdmin';

export const adminRouter = express.Router();

adminRouter.use((req: Request, res: Response, next: NextFunction) => {
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

async function tenantIdForSlug(slug: string): Promise<string | null> {
  const { data } = await supabaseAdmin.from('tenants').select('id').eq('slug', slug).maybeSingle();
  return data?.id ?? null;
}

/** POST /api/admin/tenants/:slug/retry-provision — re-run provisioning for a failed tenant. */
adminRouter.post(
  '/tenants/:slug/retry-provision',
  express.json(),
  requireSuperAdminPerm('restaurants.manage'),
  async (req: Request, res: Response) => {
    const { data: t } = await supabaseAdmin
      .from('tenants')
      .select('id, restaurant_name, slug, owner_email, owner_name, status')
      .eq('slug', req.params.slug ?? '')
      .maybeSingle();
    if (!t) return res.status(404).json({ error: 'not_found' });
    if (t.status === 'active') return res.status(409).json({ error: 'already_active' });

    void provisionTenant({
      tenantId: t.id,
      restaurantName: t.restaurant_name,
      slug: t.slug,
      ownerEmail: t.owner_email,
      ownerName: t.owner_name ?? undefined,
    });
    res.status(202).json({ ok: true, status: 'provisioning' });
  },
);

/** POST /api/admin/tenants/:slug/resend-welcome — re-send the welcome email. */
adminRouter.post(
  '/tenants/:slug/resend-welcome',
  express.json(),
  requireSuperAdminPerm('restaurants.manage'),
  async (req: Request, res: Response) => {
    const tenantId = await tenantIdForSlug(req.params.slug ?? '');
    if (!tenantId) return res.status(404).json({ error: 'not_found' });
    try {
      const mail = await resendWelcomeEmail(tenantId);
      res.status(200).json({
        ok: mail.delivered,
        provider: mail.provider,
        error: 'error' in mail ? mail.error : undefined,
      });
    } catch (err) {
      res.status(400).json({ error: 'resend_failed', message: String((err as Error).message ?? err) });
    }
  },
);

/** POST /api/admin/resync-entitlements — push every active tenant's current
 *  plan tier/features into its own project. Backfills tenants provisioned
 *  before entitlement sync existed, and repairs drift after a plan's
 *  feature list is edited (that edit is a direct RLS write from the admin
 *  browser, with no automatic per-tenant push of its own). */
adminRouter.post(
  '/resync-entitlements',
  express.json(),
  requireSuperAdminPerm('restaurants.manage'),
  async (req: Request, res: Response) => {
    const result = await syncEntitlementsForAllTenants();
    res.json({ ok: true, ...result });
  },
);

/** GET /api/admin/tenants/:slug/summary — lightweight per-tenant-project
 *  headcount, fetched lazily (only when a restaurant/customer drawer opens,
 *  never in the main directory list) via the one sanctioned cross-project
 *  path (tenantServiceClientBySlug). Never touches operational rows
 *  (orders/menu/inventory) — staff count only. */
adminRouter.get(
  '/tenants/:slug/summary',
  requireSuperAdminPerm('restaurants.view'),
  async (req: Request, res: Response) => {
    const slug = req.params.slug ?? '';
    if (!slug) return res.status(400).json({ error: 'missing_slug' });
    try {
      const svc = await tenantServiceClientBySlug(slug);
      if (!svc) return res.status(404).json({ error: 'not_found' });
      const { count, error } = await svc.admin
        .from('memberships')
        .select('id', { count: 'exact', head: true })
        .eq('status', 'active');
      if (error) throw new Error(error.message);
      res.json({ ok: true, staff_count: count ?? 0 });
    } catch (err) {
      res.status(502).json({ error: 'summary_failed', message: String((err as Error).message ?? err) });
    }
  },
);

/** GET /api/admin/invoices?customer=<stripe_customer_id> — recent Stripe
 *  invoices, optionally scoped to one tenant's customer. Stripe stays the
 *  source of truth; nothing is duplicated locally. */
adminRouter.get('/invoices', requireSuperAdminPerm('invoices.view'), async (req: Request, res: Response) => {
  const customer = typeof req.query.customer === 'string' ? req.query.customer : undefined;
  try {
    const invoices = await stripe.invoices.list({ customer, limit: 50 });
    res.json({
      invoices: invoices.data.map((inv) => ({
        id: inv.id,
        customer: typeof inv.customer === 'string' ? inv.customer : inv.customer?.id,
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
