import { randomBytes } from 'node:crypto';
import express, { type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import { env } from '../env';
import { tenantServiceClientBySlug } from '../lib/tenantAdmin';

export const portalsRouter = express.Router();

portalsRouter.use((req: Request, res: Response, next: NextFunction) => {
  const origin = req.headers.origin;
  if (origin && (origin === env.APP_URL || /^http:\/\/localhost:\d+$/.test(origin))) {
    res.header('Access-Control-Allow-Origin', origin);
    res.header('Vary', 'Origin');
  }
  res.header('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return void res.sendStatus(204);
  next();
});

const PORTAL_TYPES = ['super_admin', 'checkout', 'kitchen', 'attendance', 'manager', 'custom'] as const;

function tempPassword(): string {
  const a = 'abcdefghjkmnpqrstuvwxyz';
  const n = '23456789';
  const pick = (s: string, k: number) => {
    const b = randomBytes(k);
    let out = '';
    for (let i = 0; i < k; i++) out += s.charAt((b[i] as number) % s.length);
    return out;
  };
  return `${pick(a.toUpperCase(), 1)}${pick(a, 3)}-${pick(a, 2)}${pick(n, 2)}-${pick(n, 1)}${pick(a, 3)}`;
}

function routeKey(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'portal'
  );
}

/**
 * Resolve the tenant admin client and verify the caller holds `need`.
 * Caller proves identity with their tenant-project access token.
 */
async function authorize(
  req: Request,
  res: Response,
  slug: string,
  need: string,
): Promise<{ admin: SupabaseClient } | null> {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'missing_token' });
    return null;
  }
  const svc = await tenantServiceClientBySlug(slug);
  if (!svc) {
    res.status(404).json({ error: 'restaurant_not_found' });
    return null;
  }
  const { data: caller } = await svc.admin.auth.getUser(auth.slice(7));
  const perms = (caller?.user?.app_metadata as { permissions?: string[] } | undefined)?.permissions ?? [];
  if (!caller?.user || !(perms.includes('*') || perms.includes(need))) {
    res.status(403).json({ error: 'forbidden' });
    return null;
  }
  return { admin: svc.admin };
}

const createSchema = z.object({
  slug: z.string().min(1),
  name: z.string().trim().min(2).max(60),
  type: z.enum(PORTAL_TYPES).default('custom'),
  permissions: z.array(z.string().max(48)).max(64).default([]),
  password: z.string().min(8).max(200).optional(),
});

/** POST /api/portals — create a portal + its login. */
portalsRouter.post('/', express.json(), async (req: Request, res: Response) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) return res.status(422).json({ error: 'invalid_request' });
  const { slug, name, type, permissions } = parsed.data;

  const ok = await authorize(req, res, slug, 'portals.create');
  if (!ok) return;
  const { admin } = ok;

  // Unique route_key.
  let key = routeKey(name);
  for (let i = 2; ; i++) {
    const { data: clash } = await admin.from('portals').select('id').eq('route_key', key).maybeSingle();
    if (!clash) break;
    key = `${routeKey(name)}-${i}`;
  }

  // 1. row (need its id for the Auth user's app_metadata)
  const { data: portal, error: pErr } = await admin
    .from('portals')
    .insert({ name, type, route_key: key, permissions })
    .select('id, name, type, route_key, status, permissions')
    .single();
  if (pErr || !portal) return res.status(400).json({ error: 'create_failed', message: pErr?.message });

  // 2. Auth user (the generic portal login)
  const password = parsed.data.password ?? tempPassword();
  const email = `${key}@${slug}.portal`;
  const { data: created, error: uErr } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    app_metadata: { kind: 'portal', portal_id: portal.id, portal_route: key, permissions },
  });
  if (uErr || !created?.user) {
    await admin.from('portals').delete().eq('id', portal.id);
    return res.status(400).json({ error: 'user_create_failed', message: uErr?.message });
  }

  await admin.from('portals').update({ portal_user_id: created.user.id }).eq('id', portal.id);

  res.status(201).json({
    portal,
    login: { email, password: parsed.data.password ? undefined : password },
    url: `${env.APP_URL}/r/${slug}/portal/${key}`,
  });
});

const patchSchema = z.object({
  slug: z.string().min(1),
  name: z.string().trim().min(2).max(60).optional(),
  type: z.enum(PORTAL_TYPES).optional(),
  permissions: z.array(z.string().max(48)).max(64).optional(),
  status: z.enum(['active', 'disabled']).optional(),
});

/** PATCH /api/portals/:id — rename / retype / re-permission / enable-disable. */
portalsRouter.patch('/:id', express.json(), async (req: Request, res: Response) => {
  const parsed = patchSchema.safeParse(req.body);
  if (!parsed.success) return res.status(422).json({ error: 'invalid_request' });
  const { slug, ...changes } = parsed.data;

  const ok = await authorize(req, res, slug, 'portals.update');
  if (!ok) return;
  const { admin } = ok;

  const { data: portal } = await admin
    .from('portals')
    .select('id, type, portal_user_id, route_key')
    .eq('id', req.params.id)
    .maybeSingle();
  if (!portal) return res.status(404).json({ error: 'not_found' });
  if (portal.type === 'super_admin') {
    return res.status(409).json({ error: 'immutable', message: 'The Super Admin portal cannot be changed.' });
  }

  const { error: upErr } = await admin.from('portals').update(changes).eq('id', portal.id);
  if (upErr) return res.status(400).json({ error: 'update_failed', message: upErr.message });

  if (portal.portal_user_id && (changes.permissions || changes.status)) {
    const patch: Record<string, unknown> = {};
    if (changes.permissions) {
      patch.app_metadata = {
        kind: 'portal',
        portal_id: portal.id,
        portal_route: portal.route_key,
        permissions: changes.permissions,
      };
    }
    if (changes.status) patch.ban_duration = changes.status === 'disabled' ? '876000h' : 'none';
    await admin.auth.admin.updateUserById(portal.portal_user_id, patch);
  }
  res.json({ ok: true });
});

/** POST /api/portals/:id/password — change or reset. */
portalsRouter.post('/:id/password', express.json(), async (req: Request, res: Response) => {
  const slug = String(req.body?.slug ?? '');
  const newPw = typeof req.body?.password === 'string' ? req.body.password : undefined;
  if (newPw && (newPw.length < 8 || newPw.length > 200)) {
    return res.status(422).json({ error: 'weak_password' });
  }
  const ok = await authorize(req, res, slug, 'portals.credentials');
  if (!ok) return;
  const { admin } = ok;

  const { data: portal } = await admin
    .from('portals')
    .select('portal_user_id')
    .eq('id', req.params.id)
    .maybeSingle();
  if (!portal?.portal_user_id) return res.status(404).json({ error: 'not_found' });

  const password = newPw ?? tempPassword();
  const { error } = await admin.auth.admin.updateUserById(portal.portal_user_id, {
    password,
    email_confirm: true,
  });
  if (error) return res.status(400).json({ error: 'reset_failed', message: error.message });
  res.json({ ok: true, password: newPw ? undefined : password });
});

/** DELETE /api/portals/:id */
portalsRouter.delete('/:id', express.json(), async (req: Request, res: Response) => {
  const slug = String(req.body?.slug ?? '');
  const ok = await authorize(req, res, slug, 'portals.update');
  if (!ok) return;
  const { admin } = ok;

  const { data: portal } = await admin
    .from('portals')
    .select('id, type, portal_user_id')
    .eq('id', req.params.id)
    .maybeSingle();
  if (!portal) return res.status(404).json({ error: 'not_found' });
  if (portal.type === 'super_admin') return res.status(409).json({ error: 'immutable' });

  await admin.from('portals').delete().eq('id', portal.id);
  if (portal.portal_user_id) {
    await admin.auth.admin.deleteUser(portal.portal_user_id).catch(() => {});
  }
  res.json({ ok: true });
});
