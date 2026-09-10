import express, { type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import { env } from '../env';
import { tenantServiceClientBySlug } from '../lib/tenantAdmin';

export const staffRouter = express.Router();

staffRouter.use((req: Request, res: Response, next: NextFunction) => {
  const origin = req.headers.origin;
  if (origin && (origin === env.APP_URL || /^http:\/\/localhost:\d+$/.test(origin))) {
    res.header('Access-Control-Allow-Origin', origin);
    res.header('Vary', 'Origin');
  }
  res.header('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') {
    res.sendStatus(204);
    return;
  }
  next();
});

const bodySchema = z.object({
  slug: z.string().min(1),
  email: z.string().email(),
  full_name: z.string().trim().max(120).optional(),
  role: z.enum(['manager', 'cashier', 'chef', 'waiter', 'host', 'hr', 'accountant', 'delivery']),
  password: z.string().min(8).max(200),
});

/**
 * POST /api/staff  — owner/manager creates a staff account in the restaurant's
 * own project. Caller proves identity with their tenant-project access token
 * in the Authorization header. The admin key is ephemeral (see tenantAdmin).
 */
staffRouter.post('/', express.json(), async (req: Request, res: Response) => {
  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) {
    return res
      .status(422)
      .json({ error: 'invalid_request', details: parsed.error.flatten().fieldErrors });
  }
  const { slug, email, full_name, role, password } = parsed.data;

  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) return res.status(401).json({ error: 'missing_token' });
  const callerToken = auth.slice(7);

  const svc = await tenantServiceClientBySlug(slug);
  if (!svc) return res.status(404).json({ error: 'restaurant_not_found' });
  const { admin } = svc;

  const { data: caller } = await admin.auth.getUser(callerToken);
  const callerRole = (caller?.user?.app_metadata as { role?: string } | undefined)?.role;
  if (!caller?.user) return res.status(401).json({ error: 'invalid_token' });
  if (callerRole !== 'owner' && callerRole !== 'manager') {
    return res.status(403).json({ error: 'forbidden' });
  }

  const { data: created, error: cErr } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    app_metadata: { role },
    user_metadata: full_name ? { full_name } : {},
  });
  if (cErr || !created?.user) {
    return res.status(400).json({ error: 'create_failed', message: cErr?.message });
  }

  const { error: mErr } = await admin.from('memberships').insert({
    user_id: created.user.id,
    email,
    full_name: full_name ?? null,
    role,
    status: 'active',
  });
  if (mErr) return res.status(400).json({ error: 'membership_failed', message: mErr.message });

  res.status(201).json({ ok: true, email, role });
});
