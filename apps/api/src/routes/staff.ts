import express, { type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import { env } from '../env';
import { requirePortalPerm } from '../middleware/portalAuth';

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
 * POST /api/staff  — create a staff account in the restaurant's own project.
 * Caller proves identity with their tenant-project access token; requirePortalPerm
 * resolves the tenant, verifies the JWT and enforces `staff.create`.
 */
staffRouter.post(
  '/',
  express.json(),
  requirePortalPerm('staff.create'),
  async (req: Request, res: Response) => {
    const parsed = bodySchema.safeParse(req.body);
    if (!parsed.success) {
      return res
        .status(422)
        .json({ error: 'invalid_request', details: parsed.error.flatten().fieldErrors });
    }
    const { email, full_name, role, password } = parsed.data;
    const { admin } = req.tenant!;

    // Without this, app_metadata.permissions is absent -> every
    // permission check downstream (has_perm/permits/can) reads it as an
    // empty array and falls back to the "transitional: an owner/manager
    // with no explicit permissions still writes" rule — silently giving
    // a BRAND NEW manager full owner-equivalent access from account
    // creation, before the Owner ever visits Portal & Access Control.
    // Embedding the role's real current permission set here is what
    // makes that configuration actually take effect from day one.
    const { data: roleRow } = await admin.from('roles').select('permissions').eq('key', role).maybeSingle();
    const rolePermissions = (roleRow?.permissions as string[] | undefined) ?? [];

    const { data: created, error: cErr } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      app_metadata: { role, permissions: rolePermissions },
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
  },
);

const accessSchema = z.object({
  slug: z.string().min(1),
  membership_id: z.string().uuid(),
  role: z.enum(['owner', 'manager', 'cashier', 'chef', 'waiter', 'host', 'hr', 'accountant', 'delivery']),
  extra_permissions: z.array(z.string().max(48)).max(128).optional(),
});

/**
 * POST /api/staff/access — change a member's role (and optional extra grants).
 * set_member_access refuses to grant a permission the caller does not hold; on
 * success the member's Auth user is synced with the new effective permissions.
 */
staffRouter.post(
  '/access',
  express.json(),
  requirePortalPerm('permissions.assign'),
  async (req: Request, res: Response) => {
    const parsed = accessSchema.safeParse(req.body);
    if (!parsed.success) {
      return res
        .status(422)
        .json({ error: 'invalid_request', details: parsed.error.flatten().fieldErrors });
    }
    const { membership_id, role, extra_permissions } = parsed.data;
    const { admin, permissions } = req.tenant!;
    const extra = extra_permissions ?? [];

    const [{ data: member, error: mErr }, { data: roleRow, error: rlErr }] = await Promise.all([
      admin.from('memberships').select('id, user_id').eq('id', membership_id).maybeSingle(),
      admin.from('roles').select('permissions').eq('key', role).maybeSingle(),
    ]);
    if (mErr || !member) return res.status(404).json({ error: 'member_not_found' });
    if (rlErr || !roleRow) return res.status(422).json({ error: 'unknown_role' });

    // Effective set the target will end up with, and the anti-escalation check:
    // the caller can only grant permissions it holds ('*' = anything).
    const preset = (roleRow.permissions as string[]) ?? [];
    const effectiveKeys = preset.includes('*')
      ? ['*']
      : [...new Set([...preset, ...extra])];
    if (!permissions.includes('*')) {
      const overreach = effectiveKeys.filter((k) => !permissions.includes(k));
      if (overreach.length) {
        return res.status(403).json({
          error: 'forbidden',
          message: `You can't grant: ${overreach.join(', ')}`,
        });
      }
    }

    const { data: effective, error: rErr } = await admin.rpc('set_member_access', {
      p_membership_id: membership_id,
      p_role: role,
      p_extra: extra,
    });
    if (rErr) {
      const msg = rErr.message ?? 'assignment failed';
      const status = /do not hold|forbidden|insufficient/i.test(msg) ? 403 : 400;
      return res.status(status).json({ error: 'assign_failed', message: msg });
    }

    const perms = (effective as string[] | null) ?? [];
    if (member.user_id) {
      const { data: u } = await admin.auth.admin.getUserById(member.user_id);
      const existing = (u?.user?.app_metadata ?? {}) as Record<string, unknown>;
      await admin.auth.admin.updateUserById(member.user_id, {
        app_metadata: { ...existing, role, permissions: perms },
      });
    }

    res.json({ ok: true, role, permissions: perms });
  },
);
