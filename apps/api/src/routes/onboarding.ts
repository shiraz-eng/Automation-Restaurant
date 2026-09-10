import express, { type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import { supabaseAdmin } from '../supabase';
import { env, oauthConnectEnabled } from '../env';
import { provisionTenant } from '../provisioning';
import { hashClaimToken } from '../lib/tokens';
import { tenantServiceClient } from '../lib/tenantAdmin';
import {
  stripe,
  billingConfigured,
  priceIdFor,
  createSubscriptionCheckout,
} from '../stripe';
import {
  buildAuthorizeUrl,
  createOAuthState,
  consumeOAuthState,
  exchangeAndStore,
} from '../lib/supabaseOAuth';

export const onboardingRouter = express.Router();

// Called cross-origin from the checkout + provisioning-status pages in dev.
onboardingRouter.use((req: Request, res: Response, next: NextFunction) => {
  const origin = req.headers.origin;
  if (origin && (origin === env.APP_URL || /^http:\/\/localhost:\d+$/.test(origin))) {
    res.header('Access-Control-Allow-Origin', origin);
    res.header('Vary', 'Origin');
  }
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    res.sendStatus(204);
    return;
  }
  next();
});

const signupSchema = z.object({
  restaurant_name: z.string().trim().min(2).max(120),
  owner_name: z.string().trim().max(120).optional(),
  owner_email: z.string().trim().email(),
  phone: z.string().trim().max(40).optional(),
  country: z.string().trim().max(80).optional(),
  address: z.string().trim().max(300).optional(),
  branch_name: z.string().trim().max(120).optional(),
  table_count: z.coerce.number().int().positive().max(2000).optional(),
  plan: z.enum(['starter', 'growth', 'enterprise']).default('growth'),
  billing_interval: z.enum(['monthly', 'annual']).default('monthly'),
});

/**
 * POST /api/onboarding/signup
 *
 * Step 1 of the paid onboarding flow: creates a Stripe Checkout Session and
 * returns its URL. NOTHING is provisioned here — the tenant is created and its
 * dedicated Supabase project is built only after Stripe's webhook verifies the
 * payment server-side (see webhooks/stripe.ts -> handleCheckoutCompleted).
 */
onboardingRouter.post('/signup', express.json(), async (req: Request, res: Response) => {
  const parsed = signupSchema.safeParse(req.body);
  if (!parsed.success) {
    return res
      .status(422)
      .json({ error: 'invalid_request', details: parsed.error.flatten().fieldErrors });
  }
  const d = parsed.data;

  if (!billingConfigured) {
    return res.status(503).json({
      error: 'billing_unavailable',
      message: 'Online payment is not configured on this server yet.',
    });
  }
  const priceId = priceIdFor(d.plan, d.billing_interval);
  if (!priceId) {
    return res.status(503).json({
      error: 'plan_unavailable',
      message: `No price is configured for the ${d.plan} / ${d.billing_interval} plan.`,
    });
  }

  const base = env.CHECKOUT_RETURN_URL ?? env.APP_URL;
  try {
    const session = await createSubscriptionCheckout({
      priceId,
      customerEmail: d.owner_email,
      successUrl: `${base}/onboarding/pending?cs={CHECKOUT_SESSION_ID}`,
      cancelUrl: `${base}/get-started?plan=${d.plan}&cycle=${d.billing_interval}&canceled=1`,
      metadata: {
        restaurant_name: d.restaurant_name,
        owner_name: d.owner_name ?? '',
        owner_email: d.owner_email,
        plan: d.plan,
        billing_interval: d.billing_interval,
        phone: d.phone ?? '',
        country: d.country ?? '',
        address: d.address ?? '',
        branch_name: d.branch_name ?? '',
        table_count: d.table_count ? String(d.table_count) : '',
      },
    });
    return res.status(200).json({ ok: true, checkout_url: session.url });
  } catch (err) {
    console.error('[onboarding] checkout session create failed:', err);
    return res.status(502).json({ error: 'checkout_failed' });
  }
});

/**
 * GET /api/onboarding/session/:cs — polled by the post-payment "pending" page.
 * Reports whether Stripe marked the session paid and, once the webhook has
 * created the tenant, the slug + provisioning status.
 */
onboardingRouter.get('/session/:cs', async (req: Request, res: Response) => {
  const cs = req.params.cs ?? '';
  let paid = false;
  let subscriptionId: string | null = null;
  try {
    const s = await stripe.checkout.sessions.retrieve(cs);
    paid = s.payment_status === 'paid';
    subscriptionId =
      typeof s.subscription === 'string' ? s.subscription : (s.subscription?.id ?? null);
  } catch {
    return res.status(404).json({ error: 'unknown_session' });
  }

  let slug: string | null = null;
  let status: string | null = null;
  if (subscriptionId) {
    const { data } = await supabaseAdmin
      .from('subscriptions')
      .select('tenants(slug, status)')
      .eq('stripe_subscription_id', subscriptionId)
      .maybeSingle();
    const t = (data as { tenants?: { slug?: string; status?: string } | { slug?: string; status?: string }[] } | null)
      ?.tenants;
    const tt = Array.isArray(t) ? t[0] : t;
    slug = tt?.slug ?? null;
    status = tt?.status ?? null;
  }
  res.json({ paid, slug, status });
});

/** Best-effort public origin of this API, for building the connect URL. */
function apiOrigin(req: Request): string {
  const proto = (req.headers['x-forwarded-proto'] as string) ?? req.protocol;
  const host = req.headers['x-forwarded-host'] ?? req.headers.host;
  return `${proto}://${host}`;
}

/**
 * GET /api/onboarding/connect/start?slug=...
 * Redirects the owner to Supabase to authorise our OAuth app against their org.
 */
onboardingRouter.get('/connect/start', async (req: Request, res: Response) => {
  if (!oauthConnectEnabled) {
    return res.status(503).send('Supabase connect is not configured on this server.');
  }
  const slug = String(req.query.slug ?? '');
  const { data: tenant } = await supabaseAdmin
    .from('tenants')
    .select('id, slug, status')
    .eq('slug', slug)
    .maybeSingle();
  if (!tenant) return res.status(404).send('Unknown restaurant.');

  if (tenant.status === 'active') {
    return res.redirect(`${env.APP_URL}/r/${tenant.slug}/login`);
  }
  if (tenant.status === 'provisioning') {
    return res.redirect(`${env.APP_URL}/onboarding/${tenant.slug}`);
  }

  try {
    // Retrying after a failure: clear the stale error while we go around again.
    if (tenant.status === 'failed') {
      await supabaseAdmin
        .from('tenants')
        .update({ status: 'awaiting_connection', provisioning_error: null })
        .eq('id', tenant.id);
    }
    const state = await createOAuthState(tenant.id);
    res.redirect(buildAuthorizeUrl(state));
  } catch (err) {
    console.error('[onboarding] connect/start failed:', err);
    res.status(500).send('Could not start the Supabase connection.');
  }
});

/**
 * GET /api/onboarding/connect/callback?code=...&state=...
 * Supabase redirects here after the owner authorises. Exchanges the code,
 * stores the org grant, and kicks off provisioning into their org.
 */
onboardingRouter.get('/connect/callback', async (req: Request, res: Response) => {
  const { code, state, error: oauthError } = req.query as Record<string, string | undefined>;
  const done = (slug: string, q = '') => res.redirect(`${env.APP_URL}/onboarding/${slug}${q}`);

  const tenantId = state ? await consumeOAuthState(state) : null;
  if (!tenantId) {
    return res.status(400).send('This Supabase connection link is invalid or has expired.');
  }
  const { data: tenant } = await supabaseAdmin
    .from('tenants')
    .select('id, slug, restaurant_name, owner_email, owner_name')
    .eq('id', tenantId)
    .maybeSingle();
  if (!tenant) return res.status(404).send('Unknown restaurant.');

  if (oauthError || !code) {
    return done(tenant.slug, '?connect=denied');
  }

  try {
    await exchangeAndStore(tenantId, code);
    await supabaseAdmin
      .from('tenants')
      .update({ status: 'provisioning', provisioning_error: null })
      .eq('id', tenantId);

    void provisionTenant({
      tenantId,
      restaurantName: tenant.restaurant_name,
      slug: tenant.slug,
      ownerEmail: tenant.owner_email,
      ownerName: tenant.owner_name ?? undefined,
    });
    done(tenant.slug);
  } catch (err) {
    console.error('[onboarding] connect/callback failed:', err);
    await supabaseAdmin
      .from('tenants')
      .update({ provisioning_error: String((err as Error).message ?? err) })
      .eq('id', tenantId);
    done(tenant.slug, '?connect=error');
  }
});

/** GET /api/onboarding/status/:slug — polled by the provisioning screen. */
onboardingRouter.get('/status/:slug', async (req: Request, res: Response) => {
  const slug = req.params.slug ?? '';
  const { data } = await supabaseAdmin
    .from('tenants')
    .select('status, provisioning_error, restaurant_name')
    .eq('slug', slug)
    .maybeSingle();
  if (!data) return res.status(404).json({ error: 'not_found' });
  // A failed connect/provision is recoverable by re-authorizing, so offer the
  // link on both 'awaiting_connection' and 'failed' when connect is enabled.
  const canConnect =
    oauthConnectEnabled &&
    (data.status === 'awaiting_connection' || data.status === 'failed');
  res.json({
    status: data.status,
    error: data.provisioning_error ?? null,
    restaurant_name: data.restaurant_name,
    connect_url: canConnect
      ? `${apiOrigin(req)}/api/onboarding/connect/start?slug=${encodeURIComponent(slug)}`
      : null,
  });
});

const claimSchema = z.object({
  token: z.string().min(20),
  password: z.string().min(10).max(200),
  fullName: z.string().trim().min(1).max(120).optional(),
});

/**
 * POST /api/onboarding/claim
 *
 * Exchanges a single-use onboarding token for the owner account — created in
 * that restaurant's OWN Supabase project (looked up from the control-plane
 * registry). Token is claimed with a conditional UPDATE; released on failure.
 */
onboardingRouter.post('/claim', express.json(), async (req: Request, res: Response) => {
  const parsed = claimSchema.safeParse(req.body);
  if (!parsed.success) {
    return res
      .status(422)
      .json({ error: 'invalid_request', details: parsed.error.flatten().fieldErrors });
  }
  const { token, password, fullName } = parsed.data;
  const tokenHash = hashClaimToken(token);
  const now = new Date().toISOString();

  const { data: claimed, error: claimErr } = await supabaseAdmin
    .from('onboarding_tokens')
    .update({ used_at: now })
    .eq('token_hash', tokenHash)
    .is('used_at', null)
    .gt('expires_at', now)
    .select('id, tenant_id, email')
    .maybeSingle();

  if (claimErr) {
    console.error('[onboarding] token claim query failed:', claimErr.message);
    return res.status(500).json({ error: 'server_error' });
  }
  if (!claimed) {
    return res.status(400).json({ error: 'invalid_or_expired_token' });
  }

  const release = () =>
    supabaseAdmin.from('onboarding_tokens').update({ used_at: null }).eq('id', claimed.id);

  try {
    // Ephemeral admin client for the restaurant's project (re-derived from the
    // OAuth grant for connect-flow tenants; stored key for legacy tenants).
    const svc = await tenantServiceClient(claimed.tenant_id);
    if (!svc) throw new Error('tenant project not ready');
    const tenantAdmin = svc.admin;
    const { data: slugRow } = await supabaseAdmin
      .from('tenants')
      .select('slug')
      .eq('id', claimed.tenant_id)
      .maybeSingle();

    // Create the owner, or — if provisioning already made the user and this is a
    // re-run of the claim link (e.g. forgotten password) — reset it in place.
    const { data: created, error: userErr } = await tenantAdmin.auth.admin.createUser({
      email: claimed.email,
      password,
      email_confirm: true,
      app_metadata: { role: 'owner' }, // the project IS the tenant; only role matters
      user_metadata: fullName ? { full_name: fullName } : {},
    });

    let userId = created?.user?.id;
    if (userErr || !userId) {
      const alreadyExists =
        userErr?.status === 422 ||
        /already (been )?registered|already exists|email_exists/i.test(userErr?.message ?? '');
      if (!alreadyExists) {
        throw new Error(userErr?.message ?? 'createUser returned no user');
      }
      const { data: list, error: listErr } = await tenantAdmin.auth.admin.listUsers();
      if (listErr) throw new Error(`listUsers failed: ${listErr.message}`);
      const existing = list.users.find(
        (u) => u.email?.toLowerCase() === claimed.email.toLowerCase(),
      );
      if (!existing) throw new Error('owner user reported as existing but not found');
      userId = existing.id;
      const { error: updErr } = await tenantAdmin.auth.admin.updateUserById(userId, {
        password,
        email_confirm: true,
        app_metadata: { ...(existing.app_metadata ?? {}), role: 'owner' },
        ...(fullName ? { user_metadata: { ...(existing.user_metadata ?? {}), full_name: fullName } } : {}),
      });
      if (updErr) throw new Error(`password reset failed: ${updErr.message}`);
    }

    const { error: memErr } = await tenantAdmin.from('memberships').upsert(
      {
        user_id: userId,
        email: claimed.email,
        full_name: fullName ?? null,
        role: 'owner',
        status: 'active',
      },
      { onConflict: 'email' },
    );
    if (memErr) throw new Error(`membership upsert failed: ${memErr.message}`);

    return res.status(200).json({ ok: true, slug: slugRow?.slug ?? null });
  } catch (err) {
    console.error('[onboarding] account setup failed, releasing token:', err);
    await release();
    return res.status(500).json({ error: 'account_setup_failed' });
  }
});
