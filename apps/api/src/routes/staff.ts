import express, { type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import { isAllowedOrigin, env } from '../env';
import { requirePortalPerm, holdsAll } from '../middleware/portalAuth';

export const staffRouter = express.Router();

staffRouter.use((req: Request, res: Response, next: NextFunction) => {
  const origin = req.headers.origin;
  if (isAllowedOrigin(origin)) {
    res.header('Access-Control-Allow-Origin', origin);
    res.header('Vary', 'Origin');
  }
  res.header('Access-Control-Allow-Methods', 'POST, PATCH, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Branch-Ids');
  if (req.method === 'OPTIONS') {
    res.sendStatus(204);
    return;
  }
  next();
});

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/;
const bodySchema = z.object({
  slug: z.string().min(1),
  full_name: z.string().trim().min(1).max(120),
  job_title: z.string().trim().min(1).max(60),
  shift_start_time: z.string().regex(TIME_RE).optional(),
});

/**
 * POST /api/staff — add a staff member: a name, a job title the owner types
 * ("Waiter", "Tandoor chef"…) and an optional shift start. No login is
 * created and no permissions are granted — people reach their screens
 * through custom portals; shifts and attendance point at this record.
 * requirePortalPerm resolves the tenant, verifies the JWT and enforces
 * `staff.create`.
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
    const { full_name, job_title, shift_start_time } = parsed.data;
    const { admin } = req.tenant!;

    const { data: member, error: mErr } = await admin
      .from('memberships')
      .insert({
        user_id: null,
        email: null,
        full_name,
        job_title,
        role: 'staff',
        status: 'active',
        shift_start_time: shift_start_time ?? null,
      })
      .select('id')
      .single();
    if (mErr) return res.status(400).json({ error: 'create_failed', message: mErr.message });

    res.status(201).json({ ok: true, id: member.id });
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

const patchSchema = z
  .object({
    slug: z.string().min(1),
    shift_start_time: z.string().regex(TIME_RE).nullable().optional(),
    job_title: z.string().trim().min(1).max(60).optional(),
  })
  .refine((b) => b.shift_start_time !== undefined || b.job_title !== undefined, { message: 'nothing to update' });

/**
 * PATCH /api/staff/:id — change a member's job title and/or set/clear their
 * default shift start time (memberships.shift_start_time), used by
 * app.recompute_attendance() as the late-detection fallback when no
 * explicit shift is scheduled for a given day (tenant-migrations/0053).
 */
staffRouter.patch(
  '/:id',
  express.json(),
  requirePortalPerm('staff.update'),
  async (req: Request, res: Response) => {
    const parsed = patchSchema.safeParse(req.body);
    if (!parsed.success) {
      return res
        .status(422)
        .json({ error: 'invalid_request', details: parsed.error.flatten().fieldErrors });
    }
    const { admin } = req.tenant!;
    const { shift_start_time, job_title } = parsed.data;
    const { error } = await admin
      .from('memberships')
      .update({
        ...(shift_start_time !== undefined ? { shift_start_time } : {}),
        ...(job_title !== undefined ? { job_title } : {}),
      })
      .eq('id', req.params.id);
    if (error) return res.status(400).json({ error: 'update_failed', message: error.message });
    res.json({ ok: true });
  },
);

/**
 * DELETE /api/staff/:id — remove a staff member (staff.delete). Their login
 * is deleted so they can no longer sign in, and the membership is disabled
 * rather than dropped: attendance, shifts and audit history reference it and
 * are kept. Nobody can remove the owner, themselves, or a member who holds
 * access the caller doesn't.
 */
staffRouter.delete(
  '/:id',
  express.json(),
  requirePortalPerm('staff.delete'),
  async (req: Request, res: Response) => {
    const { admin, permissions, role, userId } = req.tenant!;
    const { data: member } = await admin
      .from('memberships')
      .select('id, user_id, role, status')
      .eq('id', req.params.id)
      .maybeSingle();
    if (!member) return res.status(404).json({ error: 'not_found' });
    if (member.role === 'owner') {
      return res.status(409).json({ error: 'immutable', message: 'The owner cannot be removed.' });
    }
    if (member.user_id && member.user_id === userId) {
      return res.status(409).json({ error: 'self', message: "You can't remove yourself." });
    }

    const { data: eff } = await admin.rpc('membership_effective_permissions', { p_membership_id: member.id });
    const effective = ((eff as { effective: string[] }[] | null)?.[0]?.effective ?? []) as string[];
    if (!holdsAll(permissions, role, effective)) {
      return res
        .status(403)
        .json({ error: 'forbidden', message: 'That staff member has access you do not hold, so you cannot remove them.' });
    }

    const { error } = await admin
      .from('memberships')
      .update({ status: 'disabled', user_id: null, extra_permissions: [] })
      .eq('id', member.id);
    if (error) return res.status(400).json({ error: 'remove_failed', message: error.message });
    await admin.from('portal_staff').delete().eq('membership_id', member.id);
    if (member.user_id) {
      await admin.auth.admin.deleteUser(member.user_id).catch(() => {});
    }
    res.json({ ok: true });
  },
);
