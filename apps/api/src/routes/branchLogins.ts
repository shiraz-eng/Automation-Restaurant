import express, { type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import { isAllowedOrigin, env } from '../env';
import { requirePortalPerm } from '../middleware/portalAuth';
import { tempPassword } from '../lib/tempPassword';

/**
 * Branch panel logins (multi-branch, tenant migrations 0098 + 0104).
 *
 * The owner's panel sees every branch. The owner gives each branch its own logins
 * here: a staff membership limited to that one branch, with a real sign-in. It signs
 * in at the restaurant's normal login page and gets the same panel, showing only its
 * branch — the database's branch walls enforce that, not this route.
 *
 * Only the owner (or a '*' head-office login with no branch limit) may create them or
 * reset their passwords. Everything here runs on the service client behind those checks.
 */
export const branchLoginsRouter = express.Router();

branchLoginsRouter.use((req: Request, res: Response, next: NextFunction) => {
  const origin = req.headers.origin;
  if (isAllowedOrigin(origin)) {
    res.header('Access-Control-Allow-Origin', origin);
    res.header('Vary', 'Origin');
  }
  res.header('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Branch-Ids');
  if (req.method === 'OPTIONS') return void res.sendStatus(204);
  next();
});

/** Owner (or an unlimited '*' login) only — a branch login never creates logins. */
function requireHeadOffice(req: Request, res: Response, next: NextFunction) {
  const { role, permissions, allowedBranchIds } = req.tenant!;
  if (allowedBranchIds || !(role === 'owner' || permissions.includes('*'))) {
    return res.status(403).json({ error: 'forbidden', message: 'Only the owner sets up branch logins.' });
  }
  next();
}

const ROLES = ['branch_manager', 'manager', 'cashier', 'chef', 'waiter', 'host', 'accountant', 'delivery'] as const;

const createSchema = z.object({
  slug: z.string().min(1),
  branch_id: z.string().uuid(),
  full_name: z.string().trim().min(2).max(120),
  role: z.enum(ROLES).default('branch_manager'),
  email: z.string().trim().toLowerCase().email().max(200).optional(),
  password: z.string().min(8).max(200).optional(),
});

/** POST /api/branch-logins — a sign-in for one branch's panel. */
branchLoginsRouter.post('/', express.json(), requirePortalPerm('branches.manage'), requireHeadOffice, async (req: Request, res: Response) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(422).json({
      error: 'invalid_request',
      message: Object.values(parsed.error.flatten().fieldErrors).flat().join(' ') || 'Invalid request.',
    });
  }
  const { branch_id, full_name, role } = parsed.data;
  const slug = req.tenant!.slug; // the restaurant, without a web session slot
  const { service } = req.tenant!;

  const { data: branch } = await service.from('branches').select('id, code, name, status').eq('id', branch_id).maybeSingle();
  if (!branch) return res.status(404).json({ error: 'branch_not_found', message: 'That branch does not exist.' });
  if (branch.status !== 'active') return res.status(409).json({ error: 'branch_not_active', message: 'That branch is not active.' });

  const { data: roleRow } = await service.from('roles').select('permissions').eq('key', role).maybeSingle();
  if (!roleRow) {
    return res.status(409).json({ error: 'role_missing', message: 'This restaurant is waiting for the branch-logins update (0104).' });
  }
  const permissions = (roleRow.permissions as string[]) ?? [];

  const local = full_name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30) || 'staff';
  const email = parsed.data.email ?? `${String(branch.code).toLowerCase()}-${local}@${slug}.branch`;
  const { data: clash } = await service.from('memberships').select('id').eq('email', email).maybeSingle();
  if (clash) return res.status(409).json({ error: 'email_taken', message: 'Someone at this restaurant already uses that email.' });

  const password = parsed.data.password ?? tempPassword();
  const { data: created, error: uErr } = await service.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    app_metadata: { role, permissions },
  });
  if (uErr || !created?.user) return res.status(400).json({ error: 'user_create_failed', message: uErr?.message });

  const { data: member, error: mErr } = await service
    .from('memberships')
    .insert({ user_id: created.user.id, email, full_name, role, status: 'active', branch_ids: [branch.id] })
    .select('id')
    .single();
  if (mErr || !member) {
    await service.auth.admin.deleteUser(created.user.id).catch(() => {});
    return res.status(400).json({ error: 'create_failed', message: mErr?.message });
  }

  res.status(201).json({
    id: member.id,
    branch: branch.name,
    login: { email, password: parsed.data.password ? undefined : password },
    // The branch's own session slot: it signs in next to the owner's panel in the same browser.
    url: `${env.APP_URL}/r/${slug}~${String(branch.code).toLowerCase()}/login`,
  });
});

/** POST /api/branch-logins/:id/password — the owner resets a branch login's password. */
branchLoginsRouter.post('/:id/password', express.json(), requirePortalPerm('branches.manage'), requireHeadOffice, async (req: Request, res: Response) => {
  const newPw = typeof req.body?.password === 'string' ? req.body.password : undefined;
  if (newPw && (newPw.length < 8 || newPw.length > 200)) return res.status(422).json({ error: 'weak_password' });
  const { service } = req.tenant!;
  const { data: member } = await service.from('memberships').select('id, user_id, role, branch_ids').eq('id', req.params.id).maybeSingle();
  // Branch logins only: a membership limited to branches, never the owner.
  if (!member?.user_id || member.role === 'owner' || !((member.branch_ids as string[] | null) ?? []).length) {
    return res.status(404).json({ error: 'not_found' });
  }
  const password = newPw ?? tempPassword();
  const { error } = await service.auth.admin.updateUserById(member.user_id, { password, email_confirm: true });
  if (error) return res.status(400).json({ error: 'reset_failed', message: error.message });
  res.json({ ok: true, password: newPw ? undefined : password });
});
