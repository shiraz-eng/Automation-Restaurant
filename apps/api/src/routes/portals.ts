import { randomBytes } from 'node:crypto';
import express, { type Request, type Response, type NextFunction } from 'express';
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { env } from '../env';
import { requirePortalPerm } from '../middleware/portalAuth';

export const portalsRouter = express.Router();

/**
 * Portal configuration (create/edit/delete/assign staff) is Owner-only —
 * defense-in-depth beyond the portals.* permission check: nothing in the
 * permission_catalog stops an Owner from granting portals.update to a
 * portal's own bundle (e.g. under "Portal Management" individual
 * permissions), and a staff member linked to that portal via portal_staff
 * would otherwise inherit portals.update and could call these routes
 * directly even though the /portals page itself is role-gated.
 */
function requireOwner(req: Request, res: Response, next: NextFunction) {
  if (req.tenant!.role !== 'owner') {
    return res.status(403).json({ error: 'forbidden', message: 'Owner only.' });
  }
  next();
}

/** Push freshly computed effective permissions onto each linked Auth user. */
async function backfillEffectivePermissions(
  admin: SupabaseClient,
  rows: { user_id: string | null; effective: string[] }[],
) {
  for (const row of rows) {
    if (!row.user_id) continue;
    const { data: u } = await admin.auth.admin.getUserById(row.user_id);
    const existing = (u?.user?.app_metadata ?? {}) as Record<string, unknown>;
    await admin.auth.admin.updateUserById(row.user_id, {
      app_metadata: { ...existing, permissions: row.effective },
    });
  }
}

portalsRouter.use((req: Request, res: Response, next: NextFunction) => {
  const origin = req.headers.origin;
  if (origin && (origin === env.APP_URL || /^http:\/\/localhost:\d+$/.test(origin))) {
    res.header('Access-Control-Allow-Origin', origin);
    res.header('Vary', 'Origin');
  }
  res.header('Access-Control-Allow-Methods', 'GET, POST, PATCH, PUT, DELETE, OPTIONS');
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

// permission_catalog currently holds ~125 keys (schema.sql) — 200 gives
// real headroom for that to keep growing without silently rejecting a
// legitimate "grant every portal bundle" selection. The old cap of 64
// was tuned for the flat checkbox list; the Portal-bundle toggles
// (apps/web/.../portals/PortalsManager.tsx) make it trivial to exceed
// that in a couple of clicks (e.g. Suppliers & Purchasing + Finance +
// Staff alone is already 40 keys), which is what was producing a bare
// "invalid_request" with no detail.
const MAX_PORTAL_PERMISSIONS = 200;
const createSchema = z.object({
  slug: z.string().min(1),
  name: z.string().trim().min(2).max(60),
  type: z.enum(PORTAL_TYPES).default('custom'),
  permissions: z.array(z.string().max(48)).max(MAX_PORTAL_PERMISSIONS).default([]),
  password: z.string().min(8).max(200).optional(),
});

/** POST /api/portals — create a portal + its login. */
portalsRouter.post(
  '/',
  express.json(),
  requirePortalPerm('portals.create'),
  requireOwner,
  async (req: Request, res: Response) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(422).json({
      error: 'invalid_request',
      message: Object.values(parsed.error.flatten().fieldErrors).flat().join(' ') || 'Invalid request.',
      details: parsed.error.flatten().fieldErrors,
    });
  }
  const { slug, name, type, permissions } = parsed.data;
  const { admin } = req.tenant!;

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
    .insert({ name, type, route_key: key, permissions, force_pw_change: true })
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
  permissions: z.array(z.string().max(48)).max(MAX_PORTAL_PERMISSIONS).optional(),
  status: z.enum(['active', 'disabled']).optional(),
});

/** PATCH /api/portals/:id — rename / retype / re-permission / enable-disable. */
portalsRouter.patch(
  '/:id',
  express.json(),
  requirePortalPerm('portals.update'),
  requireOwner,
  async (req: Request, res: Response) => {
  const parsed = patchSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(422).json({
      error: 'invalid_request',
      message: Object.values(parsed.error.flatten().fieldErrors).flat().join(' ') || 'Invalid request.',
      details: parsed.error.flatten().fieldErrors,
    });
  }
  const { slug: _slug, ...changes } = parsed.data;
  void _slug;
  const { admin, permissions } = req.tenant!;

  const { data: portal } = await admin
    .from('portals')
    .select('id, type, portal_user_id, route_key')
    .eq('id', req.params.id)
    .maybeSingle();
  if (!portal) return res.status(404).json({ error: 'not_found' });
  if (portal.type === 'super_admin') {
    return res.status(409).json({ error: 'immutable', message: 'The Super Admin portal cannot be changed.' });
  }

  // Same anti-escalation rule set_portal_staff enforces for linking staff:
  // an Owner without '*' (shouldn't happen in practice, but this route has
  // no other gate on the permission array itself) can't hand out a key they
  // don't hold via a portal's own bundle either.
  if (changes.permissions && !permissions.includes('*')) {
    const overreach = changes.permissions.filter((k) => !permissions.includes(k));
    if (overreach.length) {
      return res.status(403).json({ error: 'forbidden', message: `You can't grant: ${overreach.join(', ')}` });
    }
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

  // Its permissions or active status changed — every staff member linked
  // via portal_staff needs their effective permissions recomputed too, not
  // just the portal's own kiosk login above.
  if (changes.permissions || changes.status) {
    const { data: links } = await admin.from('portal_staff').select('membership_id').eq('portal_id', portal.id);
    for (const link of links ?? []) {
      const { data: recomputed } = await admin.rpc('membership_effective_permissions', {
        p_membership_id: link.membership_id,
      });
      await backfillEffectivePermissions(admin, (recomputed as { user_id: string | null; effective: string[] }[]) ?? []);
    }
  }

  res.json({ ok: true });
},
);

/** POST /api/portals/:id/password — change or reset. */
portalsRouter.post(
  '/:id/password',
  express.json(),
  requirePortalPerm('portals.credentials'),
  requireOwner,
  async (req: Request, res: Response) => {
  const newPw = typeof req.body?.password === 'string' ? req.body.password : undefined;
  if (newPw && (newPw.length < 8 || newPw.length > 200)) {
    return res.status(422).json({ error: 'weak_password' });
  }
  const { admin } = req.tenant!;

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
  // A generated temp password must be changed on next sign-in.
  await admin.from('portals').update({ force_pw_change: !newPw }).eq('id', req.params.id);
  res.json({ ok: true, password: newPw ? undefined : password });
},
);

/** DELETE /api/portals/:id */
portalsRouter.delete(
  '/:id',
  express.json(),
  requirePortalPerm('portals.update'),
  requireOwner,
  async (req: Request, res: Response) => {
  const { admin } = req.tenant!;

  const { data: portal } = await admin
    .from('portals')
    .select('id, type, portal_user_id')
    .eq('id', req.params.id)
    .maybeSingle();
  if (!portal) return res.status(404).json({ error: 'not_found' });
  if (portal.type === 'super_admin') return res.status(409).json({ error: 'immutable' });

  // Staff linked via portal_staff (cascade-deleted with the portal row
  // below) lose this portal's contribution to their effective permissions —
  // capture who, before the row (and the FK-cascaded links) are gone.
  const { data: links } = await admin.from('portal_staff').select('membership_id').eq('portal_id', portal.id);
  const linkedMembershipIds = (links ?? []).map((l) => l.membership_id as string);

  await admin.from('portals').delete().eq('id', portal.id);
  if (portal.portal_user_id) {
    await admin.auth.admin.deleteUser(portal.portal_user_id).catch(() => {});
  }

  for (const membershipId of linkedMembershipIds) {
    const { data: recomputed } = await admin.rpc('membership_effective_permissions', {
      p_membership_id: membershipId,
    });
    await backfillEffectivePermissions(admin, (recomputed as { user_id: string | null; effective: string[] }[]) ?? []);
  }

  res.json({ ok: true });
},
);

const staffSchema = z.object({
  slug: z.string().min(1),
  membership_ids: z.array(z.string().uuid()).max(200).default([]),
});

/**
 * PUT /api/portals/:id/staff — set the complete list of staff memberships
 * assigned to this portal. Each assigned member's Auth user is immediately
 * back-filled with its recomputed effective permissions (role preset ∪
 * extra_permissions ∪ every linked portal's permissions) — set_portal_staff
 * does the same anti-escalation check /api/staff/access uses (the caller
 * can't hand out a permission it doesn't itself hold) and refuses the
 * Super Admin portal outright.
 */
portalsRouter.put(
  '/:id/staff',
  express.json(),
  requirePortalPerm('portals.update'),
  requireOwner,
  async (req: Request, res: Response) => {
  const parsed = staffSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(422).json({
      error: 'invalid_request',
      message: Object.values(parsed.error.flatten().fieldErrors).flat().join(' ') || 'Invalid request.',
      details: parsed.error.flatten().fieldErrors,
    });
  }
  const { admin } = req.tenant!;

  const { data: rows, error } = await admin.rpc('set_portal_staff', {
    p_portal_id: req.params.id,
    p_membership_ids: parsed.data.membership_ids,
  });
  if (error) {
    const msg = error.message ?? 'assignment failed';
    const status = /do not hold|forbidden|insufficient|cannot be assigned/i.test(msg)
      ? 403
      : /not_found/i.test(msg)
        ? 404
        : 400;
    return res.status(status).json({ error: 'assign_failed', message: msg });
  }

  await backfillEffectivePermissions(admin, (rows as { user_id: string | null; effective: string[] }[]) ?? []);
  res.json({ ok: true });
},
);

