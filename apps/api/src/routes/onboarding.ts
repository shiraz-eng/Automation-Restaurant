import { randomUUID } from 'node:crypto';
import express, { type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import { createClient } from '@supabase/supabase-js';
import { supabaseAdmin } from '../supabase';
import { env } from '../env';
import { slugify } from '../lib/slug';
import { provisionTenant } from '../provisioning';
import { hashClaimToken } from '../lib/tokens';

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
  password: z.string().min(10).max(200).optional(),
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
 * Checkout / signup: registers the tenant, stores business details, and kicks
 * off creation of its dedicated Supabase project. If `password` is supplied the
 * owner account is created directly once the project is ready; otherwise a
 * claim link is emailed.
 */
onboardingRouter.post('/signup', express.json(), async (req: Request, res: Response) => {
  const parsed = signupSchema.safeParse(req.body);
  if (!parsed.success) {
    return res
      .status(422)
      .json({ error: 'invalid_request', details: parsed.error.flatten().fieldErrors });
  }
  const d = parsed.data;

  const { data, error } = await supabaseAdmin.rpc('register_tenant', {
    p_restaurant_name: d.restaurant_name,
    p_slug: slugify(d.restaurant_name),
    p_tier: d.plan,
    p_billing_interval: d.billing_interval,
    p_status: 'active',
    p_stripe_customer_id: null,
    p_stripe_subscription_id: `signup_${randomUUID()}`,
    p_current_period_end: null,
    p_owner_email: d.owner_email,
    p_region: env.SUPABASE_REGION,
  });
  if (error) {
    return res.status(400).json({ error: 'register_failed', message: error.message });
  }

  const row = Array.isArray(data) ? data[0] : data;

  await supabaseAdmin
    .from('tenants')
    .update({
      owner_name: d.owner_name ?? null,
      phone: d.phone ?? null,
      country: d.country ?? null,
      address: d.address ?? null,
      branch_name: d.branch_name ?? null,
      table_count: d.table_count ?? null,
    })
    .eq('id', row.tenant_id);

  void provisionTenant({
    tenantId: row.tenant_id,
    restaurantName: d.restaurant_name,
    slug: row.slug,
    ownerEmail: d.owner_email,
    ownerPassword: d.password,
    ownerName: d.owner_name,
  });

  res.status(202).json({ ok: true, slug: row.slug, status: 'provisioning' });
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
  res.json({
    status: data.status,
    error: data.provisioning_error ?? null,
    restaurant_name: data.restaurant_name,
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
    // Resolve the restaurant's dedicated project.
    const { data: proj, error: projErr } = await supabaseAdmin
      .from('tenant_projects')
      .select('project_url, service_key, tenants(slug)')
      .eq('tenant_id', claimed.tenant_id)
      .maybeSingle();
    if (projErr || !proj) {
      throw new Error(projErr?.message ?? 'tenant project not ready');
    }

    const tenantAdmin = createClient(proj.project_url, proj.service_key, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const { data: created, error: userErr } = await tenantAdmin.auth.admin.createUser({
      email: claimed.email,
      password,
      email_confirm: true,
      app_metadata: { role: 'owner' }, // the project IS the tenant; only role matters
      user_metadata: fullName ? { full_name: fullName } : {},
    });
    if (userErr || !created?.user) {
      throw new Error(userErr?.message ?? 'createUser returned no user');
    }

    const { error: memErr } = await tenantAdmin.from('memberships').insert({
      user_id: created.user.id,
      email: claimed.email,
      full_name: fullName ?? null,
      role: 'owner',
      status: 'active',
    });
    if (memErr) throw new Error(`membership insert failed: ${memErr.message}`);

    const slug = (proj as { tenants?: { slug?: string } }).tenants?.slug ?? null;
    return res.status(200).json({ ok: true, slug });
  } catch (err) {
    console.error('[onboarding] account setup failed, releasing token:', err);
    await release();
    return res.status(500).json({ error: 'account_setup_failed' });
  }
});
