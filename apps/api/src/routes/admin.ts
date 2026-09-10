import express, { type Request, type Response, type NextFunction } from 'express';
import { supabaseAdmin } from '../supabase';
import { env } from '../env';
import { provisionTenant, resendWelcomeEmail } from '../provisioning';

export const adminRouter = express.Router();

adminRouter.use((req: Request, res: Response, next: NextFunction) => {
  const origin = req.headers.origin;
  if (origin && (origin === env.APP_URL || /^http:\/\/localhost:\d+$/.test(origin))) {
    res.header('Access-Control-Allow-Origin', origin);
    res.header('Vary', 'Origin');
  }
  res.header('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return void res.sendStatus(204);
  next();
});

/** Gate: caller must present a control-plane JWT with app_metadata.role = super_admin. */
async function requireSuperAdmin(req: Request, res: Response): Promise<boolean> {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'missing_token' });
    return false;
  }
  const { data, error } = await supabaseAdmin.auth.getUser(auth.slice(7));
  const role = (data?.user?.app_metadata as { role?: string } | undefined)?.role;
  if (error || !data?.user || role !== 'super_admin') {
    res.status(403).json({ error: 'forbidden' });
    return false;
  }
  return true;
}

async function tenantIdForSlug(slug: string): Promise<string | null> {
  const { data } = await supabaseAdmin.from('tenants').select('id').eq('slug', slug).maybeSingle();
  return data?.id ?? null;
}

/** POST /api/admin/tenants/:slug/retry-provision — re-run provisioning for a failed tenant. */
adminRouter.post('/tenants/:slug/retry-provision', express.json(), async (req, res) => {
  if (!(await requireSuperAdmin(req, res))) return;
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
});

/** POST /api/admin/tenants/:slug/resend-welcome — re-send the welcome email. */
adminRouter.post('/tenants/:slug/resend-welcome', express.json(), async (req, res) => {
  if (!(await requireSuperAdmin(req, res))) return;
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
});
