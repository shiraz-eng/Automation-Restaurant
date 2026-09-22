import express, { type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import { env } from '../env';
import { supabaseAdmin } from '../supabase';
import { requireSuperAdminPerm } from '../middleware/adminAuth';

export const adminUsersRouter = express.Router();

adminUsersRouter.use((req: Request, res: Response, next: NextFunction) => {
  const origin = req.headers.origin;
  if (origin && (origin === env.APP_URL || /^http:\/\/localhost:\d+$/.test(origin))) {
    res.header('Access-Control-Allow-Origin', origin);
    res.header('Vary', 'Origin');
  }
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return void res.sendStatus(204);
  next();
});

/** GET /api/admin/team — list every platform admin + their role. */
adminUsersRouter.get('/', requireSuperAdminPerm('users.manage'), async (_req: Request, res: Response) => {
  const [{ data: admins, error }, { data: roles }] = await Promise.all([
    supabaseAdmin
      .from('platform_admins')
      .select('id, user_id, email, role, extra_permissions, status, invited_at, accepted_at')
      .order('invited_at', { ascending: false }),
    supabaseAdmin.from('platform_roles').select('key, name, permissions'),
  ]);
  if (error) return res.status(500).json({ error: 'query_failed', message: error.message });
  res.json({ admins: admins ?? [], roles: roles ?? [] });
});

const inviteSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  role: z.string().min(1),
  extra_permissions: z.array(z.string()).optional(),
});

/** Effective permission set for {role, extra} + the anti-escalation check
 *  against the caller's own verified permissions — mirrors staff.ts's
 *  /access handler exactly (spec: never trust a client-supplied role's
 *  reach without checking it against what the caller itself holds). */
async function checkOverreach(
  role: string,
  extra: string[],
  callerPerms: string[],
): Promise<{ effective: string[] } | { error: string }> {
  const { data: roleRow, error } = await supabaseAdmin
    .from('platform_roles')
    .select('permissions')
    .eq('key', role)
    .maybeSingle();
  if (error || !roleRow) return { error: 'unknown_role' };

  const preset = (roleRow.permissions as string[]) ?? [];
  const effective = preset.includes('*') ? ['*'] : [...new Set([...preset, ...extra])];
  if (!callerPerms.includes('*')) {
    const overreach = effective.filter((k) => k !== '*' && !callerPerms.includes(k));
    if (overreach.length) return { error: `You can't grant: ${overreach.join(', ')}` };
  }
  return { effective };
}

/** POST /api/admin/team/invite — invite a new platform admin. */
adminUsersRouter.post(
  '/invite',
  express.json(),
  requireSuperAdminPerm('users.manage'),
  async (req: Request, res: Response) => {
    const parsed = inviteSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(422).json({ error: 'invalid_request', details: parsed.error.flatten().fieldErrors });
    }
    const { email, role, extra_permissions } = parsed.data;
    const extra = extra_permissions ?? [];
    const callerPerms = req.admin!.role === 'super_admin' ? ['*'] : req.admin!.permissions;

    const check = await checkOverreach(role, extra, callerPerms);
    if ('error' in check) return res.status(403).json({ error: 'forbidden', message: check.error });

    const { data: existing } = await supabaseAdmin
      .from('platform_admins')
      .select('id')
      .eq('email', email)
      .maybeSingle();
    if (existing) return res.status(409).json({ error: 'already_invited' });

    const { data: invited, error: inviteErr } = await supabaseAdmin.auth.admin.inviteUserByEmail(email, {
      redirectTo: `${env.APP_URL}/admin/login`,
      data: {},
    });
    if (inviteErr || !invited?.user) {
      return res.status(502).json({ error: 'invite_failed', message: inviteErr?.message ?? 'invite failed' });
    }

    await supabaseAdmin.auth.admin.updateUserById(invited.user.id, {
      app_metadata: { role, permissions: check.effective },
    });

    const { error: insertErr } = await supabaseAdmin.from('platform_admins').insert({
      user_id: invited.user.id,
      email,
      role,
      extra_permissions: extra,
      status: 'invited',
      invited_by: req.admin!.userId,
    });
    if (insertErr) return res.status(500).json({ error: 'insert_failed', message: insertErr.message });

    res.status(201).json({ ok: true, effective_permissions: check.effective });
  },
);

const accessSchema = z.object({
  role: z.string().min(1),
  extra_permissions: z.array(z.string()).optional(),
});

/** POST /api/admin/team/:id/access — change a platform admin's role/permissions. */
adminUsersRouter.post(
  '/:id/access',
  express.json(),
  requireSuperAdminPerm('users.manage'),
  async (req: Request, res: Response) => {
    const parsed = accessSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(422).json({ error: 'invalid_request', details: parsed.error.flatten().fieldErrors });
    }
    const { role, extra_permissions } = parsed.data;
    const extra = extra_permissions ?? [];
    const callerPerms = req.admin!.role === 'super_admin' ? ['*'] : req.admin!.permissions;

    const check = await checkOverreach(role, extra, callerPerms);
    if ('error' in check) return res.status(403).json({ error: 'forbidden', message: check.error });

    const { data: effective, error: rpcErr } = await supabaseAdmin.rpc('set_admin_access', {
      p_admin_id: req.params.id,
      p_role: role,
      p_extra: extra,
    });
    if (rpcErr) {
      const status = /do not hold|forbidden|insufficient/i.test(rpcErr.message) ? 403 : 400;
      return res.status(status).json({ error: 'assign_failed', message: rpcErr.message });
    }

    const { data: target } = await supabaseAdmin
      .from('platform_admins')
      .select('user_id')
      .eq('id', req.params.id)
      .maybeSingle();
    if (target?.user_id) {
      const { data: u } = await supabaseAdmin.auth.admin.getUserById(target.user_id);
      const existing = (u?.user?.app_metadata ?? {}) as Record<string, unknown>;
      await supabaseAdmin.auth.admin.updateUserById(target.user_id, {
        app_metadata: { ...existing, role, permissions: effective },
      });
    }

    res.json({ ok: true, role, permissions: effective });
  },
);

/** POST /api/admin/team/:id/disable | /:id/reactivate */
function setStatus(status: 'disabled' | 'active') {
  return async (req: Request, res: Response) => {
    const { error } = await supabaseAdmin
      .from('platform_admins')
      .update({ status })
      .eq('id', req.params.id);
    if (error) return res.status(500).json({ error: 'update_failed', message: error.message });
    res.json({ ok: true, status });
  };
}
adminUsersRouter.post('/:id/disable', requireSuperAdminPerm('users.manage'), setStatus('disabled'));
adminUsersRouter.post('/:id/reactivate', requireSuperAdminPerm('users.manage'), setStatus('active'));
