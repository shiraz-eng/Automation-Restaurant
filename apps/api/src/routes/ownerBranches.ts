import express, { type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import { isAllowedOrigin } from '../env';
import { requirePortalPerm } from '../middleware/portalAuth';
import {
  BranchError,
  advanceBranch,
  archiveBranch,
  branchLogin,
  branchReceipt,
  createBranch,
  deleteBranchPermanently,
  friendlySetupError,
  listBranches,
  ownerSignInToken,
  renameBranch,
  restaurantMetrics,
  restoreBranch,
  retryBranch,
  setBranchLogin,
  setBranchReceipt,
  tenantBySlug,
  type TenantRow,
} from '../lib/branchTenants';

/**
 * Independent branches, from the owner's central panel (lib/branchTenants.ts).
 *
 *   GET  /api/owner-branches?slug=&from=&to=   the branches + each one's figures
 *   POST /api/owner-branches                   create (idempotent per code)
 *   POST /api/owner-branches/:id/advance       move setup forward (the panel polls this)
 *   POST /api/owner-branches/:id/retry         retry a failed setup or menu copy
 *   POST /api/owner-branches/:id/open          one-time owner sign-in into the branch
 *   GET  /api/owner-branches/:id/login         the branch's login (email, never a password)
 *   POST /api/owner-branches/:id/login         create / change it; a new password is shown once
 *   GET  /api/owner-branches/:id/receipt       the branch's own receipt details (address, phone…)
 *   POST /api/owner-branches/:id/receipt       change them
 *   PATCH /api/owner-branches/:id              rename
 *   POST /api/owner-branches/:id/archive       switch off, keep every record (restorable)
 *   POST /api/owner-branches/:id/restore
 *   POST /api/owner-branches/:id/delete        delete its project and data for good (type the code)
 *
 * The caller is always resolved from its own token for the restaurant in `slug`; a branch
 * id is only ever looked up among THAT restaurant's branches — never trusted on its own.
 */
export const ownerBranchesRouter = express.Router();

ownerBranchesRouter.use((req: Request, res: Response, next: NextFunction) => {
  const origin = req.headers.origin;
  if (isAllowedOrigin(origin)) {
    res.header('Access-Control-Allow-Origin', origin);
    res.header('Vary', 'Origin');
  }
  res.header('Access-Control-Allow-Methods', 'GET, POST, PATCH, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Branch-Ids');
  if (req.method === 'OPTIONS') return void res.sendStatus(204);
  next();
});

/** The owner of a MAIN restaurant (not a branch), or a '*' head-office login. */
async function requireOwnerPanel(req: Request, res: Response, next: NextFunction) {
  const { role, permissions, slug } = req.tenant!;
  if (!(role === 'owner' || permissions.includes('*'))) {
    return res.status(403).json({ error: 'forbidden', message: 'Only the owner manages branches.' });
  }
  const parent = await tenantBySlug(slug);
  if (!parent) return res.status(404).json({ error: 'restaurant_not_found' });
  if (parent.parent_tenant_id) {
    return res.status(403).json({ error: 'forbidden', message: 'Branches are managed from the owner’s main panel.' });
  }
  res.locals.parent = parent;
  next();
}

async function ownBranch(req: Request, res: Response): Promise<TenantRow | null> {
  const parent = res.locals.parent as TenantRow;
  const branches = await listBranches(parent.id);
  const b = branches.find((x) => x.id === req.params.id) ?? null;
  if (!b) res.status(404).json({ error: 'not_found', message: 'No such branch of this restaurant.' });
  return b;
}

const view = (b: TenantRow) => ({
  id: b.id,
  slug: b.slug,
  code: b.branch_code,
  name: b.restaurant_name,
  status: b.status, // provisioning | active | failed | suspended
  setup_error: friendlySetupError(b.provisioning_error),
  copy_status: b.branch_seed_status, // pending | done | failed
  copy_error: b.branch_seed_error,
  created_at: b.created_at,
});

function sendError(res: Response, err: unknown) {
  if (err instanceof BranchError) return res.status(err.status).json({ error: err.code, message: err.message });
  console.error('[owner-branches]', err);
  return res.status(500).json({ error: 'server_error', message: String((err as Error).message ?? err) });
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

ownerBranchesRouter.get('/', requirePortalPerm('branches.view'), requireOwnerPanel, async (req: Request, res: Response) => {
  try {
    const parent = res.locals.parent as TenantRow;
    const today = new Date().toISOString().slice(0, 10);
    const from = typeof req.query.from === 'string' && DATE.test(req.query.from) ? req.query.from : `${today.slice(0, 7)}-01`;
    const to = typeof req.query.to === 'string' && DATE.test(req.query.to) ? req.query.to : today;
    const branches = await listBranches(parent.id);
    // Each branch's figures from its OWN database, side by side — never merged rows.
    const withMetrics = await Promise.all(
      branches.map(async (b) => ({ ...view(b), metrics: b.status === 'active' ? await restaurantMetrics(b.slug, from, to) : null })),
    );
    const main = await restaurantMetrics(parent.slug, from, to);
    res.json({ period: { from, to }, main: { slug: parent.slug, name: parent.restaurant_name, metrics: main }, branches: withMetrics });
  } catch (err) {
    sendError(res, err);
  }
});

const receiptFields = {
  address: z.string().max(300).nullable().optional(),
  phone: z.string().max(60).nullable().optional(),
  contact_email: z.string().max(200).nullable().optional(),
  website: z.string().max(200).nullable().optional(),
  tax_registration_number: z.string().max(80).nullable().optional(),
  receipt_footer_text: z.string().max(500).nullable().optional(),
};
const createSchema = z.object({
  slug: z.string().min(1),
  code: z.string().trim().min(2).max(12),
  name: z.string().trim().min(2).max(60),
  // The branch's own receipt details, applied as soon as its database is ready.
  receipt: z.object(receiptFields).optional(),
});

ownerBranchesRouter.post('/', express.json(), requirePortalPerm('branches.manage'), requireOwnerPanel, async (req: Request, res: Response) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) return res.status(422).json({ error: 'invalid_request', message: 'Give the branch a code (2–12 characters) and a name.' });
  try {
    const { branch, existed, receiptPending } = await createBranch(res.locals.parent as TenantRow, {
      code: parsed.data.code,
      name: parsed.data.name,
      receipt: parsed.data.receipt,
    });
    // Setup takes a few minutes; the panel polls /advance. Nothing is "created" until it is active.
    res.status(existed ? 200 : 202).json({ branch: view(branch), existed, receipt_pending: receiptPending ?? false });
  } catch (err) {
    sendError(res, err);
  }
});

ownerBranchesRouter.post('/:id/advance', express.json(), requirePortalPerm('branches.manage'), requireOwnerPanel, async (req: Request, res: Response) => {
  try {
    const b = await ownBranch(req, res);
    if (!b) return;
    res.json({ branch: view(await advanceBranch(res.locals.parent as TenantRow, b)) });
  } catch (err) {
    sendError(res, err);
  }
});

ownerBranchesRouter.post('/:id/retry', express.json(), requirePortalPerm('branches.manage'), requireOwnerPanel, async (req: Request, res: Response) => {
  try {
    const b = await ownBranch(req, res);
    if (!b) return;
    res.json({ branch: view(await retryBranch(res.locals.parent as TenantRow, b)) });
  } catch (err) {
    sendError(res, err);
  }
});

ownerBranchesRouter.post('/:id/open', express.json(), requirePortalPerm('branches.view'), requireOwnerPanel, async (req: Request, res: Response) => {
  try {
    const parent = res.locals.parent as TenantRow;
    // Only the restaurant's own owner account is signed in as owner of the branch — not a
    // delegated '*' login, which still sees the branch list and figures.
    const { role, email } = req.tenant!;
    if (role !== 'owner' || !email || !parent.owner_email || email.toLowerCase() !== parent.owner_email.toLowerCase()) {
      return res.status(403).json({ error: 'forbidden', message: 'Only the restaurant owner can open branch workspaces from here.' });
    }
    const b = await ownBranch(req, res);
    if (!b) return;
    const token = await ownerSignInToken(b);
    res.json({ slug: b.slug, token });
  } catch (err) {
    sendError(res, err);
  }
});

/** Only the restaurant's own owner account — not a delegated '*' login. */
function requireRealOwner(req: Request, res: Response): boolean {
  const parent = res.locals.parent as TenantRow;
  const { role, email } = req.tenant!;
  if (role !== 'owner' || !email || !parent.owner_email || email.toLowerCase() !== parent.owner_email.toLowerCase()) {
    res.status(403).json({ error: 'forbidden', message: 'Only the restaurant owner can do this.' });
    return false;
  }
  return true;
}

ownerBranchesRouter.get('/:id/login', requirePortalPerm('branches.manage'), requireOwnerPanel, async (req: Request, res: Response) => {
  try {
    const b = await ownBranch(req, res);
    if (!b) return;
    res.json({ login: await branchLogin(b), url: `/r/${b.slug}/login` });
  } catch (err) {
    sendError(res, err);
  }
});

const loginSchema = z.object({
  slug: z.string().min(1),
  email: z.string().trim().email().max(200).optional(),
  name: z.string().trim().max(80).nullable().optional(),
  password: z.string().min(8).max(72).optional(),
  new_password: z.boolean().optional(),
});

ownerBranchesRouter.post('/:id/login', express.json(), requirePortalPerm('branches.manage'), requireOwnerPanel, async (req: Request, res: Response) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) return res.status(422).json({ error: 'invalid_request', message: 'Give a valid email, and a password of at least 8 characters.' });
  try {
    if (!requireRealOwner(req, res)) return;
    const b = await ownBranch(req, res);
    if (!b) return;
    const { email, name, password, new_password } = parsed.data;
    const out = await setBranchLogin(b, { email, name, password, newPassword: new_password });
    // The password (when one was set) is in this response only; it is not stored readable.
    res.json({ email: out.email, password: out.password, url: `/r/${b.slug}/login` });
  } catch (err) {
    sendError(res, err);
  }
});

const renameSchema = z.object({ slug: z.string().min(1), name: z.string().trim().min(2).max(60) });

ownerBranchesRouter.patch('/:id', express.json(), requirePortalPerm('branches.manage'), requireOwnerPanel, async (req: Request, res: Response) => {
  const parsed = renameSchema.safeParse(req.body);
  if (!parsed.success) return res.status(422).json({ error: 'invalid_request', message: 'Give the branch a name (2–60 characters).' });
  try {
    const b = await ownBranch(req, res);
    if (!b) return;
    res.json({ branch: view(await renameBranch(res.locals.parent as TenantRow, b, parsed.data.name)) });
  } catch (err) {
    sendError(res, err);
  }
});

ownerBranchesRouter.post('/:id/archive', express.json(), requirePortalPerm('branches.manage'), requireOwnerPanel, async (req: Request, res: Response) => {
  try {
    const b = await ownBranch(req, res);
    if (!b) return;
    res.json({ branch: view(await archiveBranch(b)) });
  } catch (err) {
    sendError(res, err);
  }
});

ownerBranchesRouter.post('/:id/restore', express.json(), requirePortalPerm('branches.manage'), requireOwnerPanel, async (req: Request, res: Response) => {
  try {
    const b = await ownBranch(req, res);
    if (!b) return;
    res.json({ branch: view(await restoreBranch(b)) });
  } catch (err) {
    sendError(res, err);
  }
});

const deleteSchema = z.object({ slug: z.string().min(1), confirm: z.string().trim().min(1) });

ownerBranchesRouter.post('/:id/delete', express.json(), requirePortalPerm('branches.manage'), requireOwnerPanel, async (req: Request, res: Response) => {
  const parsed = deleteSchema.safeParse(req.body);
  if (!parsed.success) return res.status(422).json({ error: 'invalid_request', message: 'Type the branch code to confirm.' });
  try {
    if (!requireRealOwner(req, res)) return;
    const b = await ownBranch(req, res);
    if (!b) return;
    await deleteBranchPermanently(b, parsed.data.confirm);
    res.json({ deleted: true, id: b.id });
  } catch (err) {
    sendError(res, err);
  }
});

ownerBranchesRouter.get('/:id/receipt', requirePortalPerm('branches.manage'), requireOwnerPanel, async (req: Request, res: Response) => {
  try {
    const b = await ownBranch(req, res);
    if (!b) return;
    res.json({ receipt: await branchReceipt(b) });
  } catch (err) {
    sendError(res, err);
  }
});

const receiptSchema = z.object({ slug: z.string().min(1), ...receiptFields });

ownerBranchesRouter.post('/:id/receipt', express.json(), requirePortalPerm('branches.manage'), requireOwnerPanel, async (req: Request, res: Response) => {
  const parsed = receiptSchema.safeParse(req.body);
  if (!parsed.success) return res.status(422).json({ error: 'invalid_request', message: 'One of the receipt details is too long.' });
  try {
    const b = await ownBranch(req, res);
    if (!b) return;
    const { slug: _slug, ...fields } = parsed.data;
    res.json({ receipt: await setBranchReceipt(b, fields) });
  } catch (err) {
    sendError(res, err);
  }
});
