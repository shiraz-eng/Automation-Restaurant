import express, { type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import { isAllowedOrigin } from '../env';
import { requirePortalPerm } from '../middleware/portalAuth';
import {
  BranchError,
  advanceBranch,
  createBranch,
  listBranches,
  ownerSignInToken,
  restaurantMetrics,
  retryBranch,
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
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
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
  setup_error: b.provisioning_error,
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

const createSchema = z.object({ slug: z.string().min(1), code: z.string().trim().min(2).max(12), name: z.string().trim().min(2).max(60) });

ownerBranchesRouter.post('/', express.json(), requirePortalPerm('branches.manage'), requireOwnerPanel, async (req: Request, res: Response) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) return res.status(422).json({ error: 'invalid_request', message: 'Give the branch a code (2–12 characters) and a name.' });
  try {
    const { branch, existed } = await createBranch(res.locals.parent as TenantRow, { code: parsed.data.code, name: parsed.data.name });
    // Setup takes a few minutes; the panel polls /advance. Nothing is "created" until it is active.
    res.status(existed ? 200 : 202).json({ branch: view(branch), existed });
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
