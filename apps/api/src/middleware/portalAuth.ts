import type { Request, Response, NextFunction } from 'express';
import type { SupabaseClient } from '@supabase/supabase-js';
import { resolveTenantClient } from '../lib/tenantAdmin';
import { fetchCurrency, runWithCurrency } from '../lib/currencyContext';

/**
 * Tenant + caller context attached by requirePortalPerm(). Routes read
 * req.tenant instead of re-resolving the restaurant and re-checking the JWT.
 */
export type TenantContext = {
  slug: string;
  admin: SupabaseClient;
  projectUrl: string;
  userId: string;
  email: string | null;
  role: string | null;
  permissions: string[];
  /** Set when the caller is a custom-portal login (app_metadata.kind = 'portal'). */
  portalId: string | null;
  /** The branches this request covers (null = every branch); `admin` is already narrowed to them. */
  branchIds: string[] | null;
  /** The branches this login may use at all (null = every branch). Set only for branch-limited logins. */
  allowedBranchIds: string[] | null;
  /**
   * The restaurant's unscoped service client. ONLY for what the caller's own token cannot do
   * (Auth accounts) or for a write the route has already validated (portals.ts, staff.ts);
   * every read and ordinary write goes through `admin`, so branch walls apply.
   */
  service: SupabaseClient;
};

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      tenant?: TenantContext;
    }
  }
}

/**
 * Does this caller hold `need`?  '*' or the exact key passes. A staff JWT with
 * NO explicit permissions array falls back to owner/manager — mirroring
 * app.has_perm()'s transitional fallback and the legacy is_staff() RLS, so
 * existing role-only logins keep working until they are back-filled.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The branches a request may cover. null = no limit (every branch). The login's own
 * assignment (portals / memberships.branch_ids) always wins over what the request asks for.
 * Before migration 0098 the columns don't exist and every request covers every branch.
 */
export async function effectiveBranchIds(
  admin: SupabaseClient,
  userId: string,
  permissions: string[],
  role: string | null,
  header: string | string[] | undefined,
): Promise<{ ids: string[] | null; limited: boolean; allowed: string[] | null }> {
  const asked = String(Array.isArray(header) ? header[0] : (header ?? ''))
    .split(',')
    .map((x) => x.trim())
    .filter((x) => UUID.test(x));
  let allowed: string[] | null = null;
  if (!(permissions.includes('*') || role === 'owner')) {
    const [p, m] = await Promise.all([
      admin.from('portals').select('branch_ids').eq('portal_user_id', userId).limit(1).maybeSingle(),
      admin.from('memberships').select('branch_ids').eq('user_id', userId).limit(1).maybeSingle(),
    ]);
    const ids = [p.data, m.data].map((r) => ((r as { branch_ids?: string[] } | null)?.branch_ids ?? [])).find((x) => x.length > 0);
    allowed = ids ?? null;
  }
  if (allowed) {
    const both = asked.filter((x) => allowed!.includes(x));
    return { ids: both.length > 0 ? both : allowed, limited: true, allowed };
  }
  return { ids: asked.length > 0 ? asked : null, limited: false, allowed: null };
}

export function permits(perms: string[], role: string | null, need: string): boolean {
  if (perms.includes('*') || perms.includes(need)) return true;
  if (perms.length === 0 && (role === 'owner' || role === 'manager')) return true;
  return false;
}

/**
 * Does the caller hold EVERY key in `perms`? Used to stop a caller managing
 * a portal/role/member that has access they don't. '*' (or a legacy owner JWT
 * with no permissions array) holds everything; nobody but '*' can hand out '*'.
 */
export function holdsAll(callerPerms: string[], role: string | null, perms: string[]): boolean {
  if (callerPerms.includes('*')) return true;
  if (callerPerms.length === 0 && role === 'owner') return true;
  if (perms.includes('*')) return false;
  return perms.every((k) => callerPerms.includes(k));
}

/**
 * Express middleware: resolve the restaurant from :slug (params, body or query),
 * verify the caller's tenant-project JWT (Authorization: Bearer …) and require
 * the `need` permission (any one of them, when given a list). On success
 * attaches req.tenant. Enforced server-side —
 * the UI hiding a control is never the check (spec §28).
 */
export function requirePortalPerm(need: string | string[]) {
  const needs = Array.isArray(need) ? need : [need];
  return async function portalPermGuard(req: Request, res: Response, next: NextFunction) {
    const slug = String(
      req.params.slug ?? (req.body as { slug?: unknown })?.slug ?? req.query.slug ?? '',
    ).trim();
    if (!slug) return res.status(400).json({ error: 'missing_restaurant' });

    const auth = req.headers.authorization;
    if (!auth?.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'sign_in_required', message: 'Please sign in again.' });
    }
    const token = auth.slice(7);

    const resolved = await resolveTenantClient(slug);
    if (!resolved.ok) {
      return resolved.reason === 'not_found'
        ? res.status(404).json({ error: 'restaurant_not_found', message: `Restaurant "${slug}" wasn't found${resolved.detail ? ` — ${resolved.detail}` : ''}.` })
        : res.status(503).json({ error: 'service_unavailable', message: 'The restaurant service is temporarily unavailable. Please try again in a moment.' });
    }
    const svc = resolved.client;

    // The restaurant's currency is looked up alongside the caller check, so it costs no extra round trip.
    const [{ data, error }, currency] = await Promise.all([svc.admin.auth.getUser(token), fetchCurrency(svc.admin)]);
    if (error || !data?.user) {
      return res
        .status(401)
        .json({ error: 'session_expired', message: 'Your session has expired. Please sign in again.' });
    }

    const meta = (data.user.app_metadata ?? {}) as {
      role?: string;
      permissions?: string[];
      kind?: string;
      portal_id?: string;
    };
    const permissions = Array.isArray(meta.permissions) ? meta.permissions : [];
    const role = meta.role ?? null;

    if (!needs.some((k) => permits(permissions, role, k))) {
      return res
        .status(403)
        .json({
          error: 'forbidden',
          // Name the account: one browser shares a single session per
          // restaurant across tabs, so "you" may be a portal login that
          // signed in elsewhere — saying which makes that obvious.
          message: data.user.email
            ? `Signed in as ${data.user.email}, which doesn't have permission to do this.`
            : "You don't have permission to perform this action.",
        });
    }

    // Multi-branch (tenant migrations 0098+): this API runs with the service key, which the
    // database's branch walls don't apply to — so the branches are worked out here and the
    // request runs on a client narrowed to them. A login limited to some branches never gets
    // past them (whatever it asks for); the owner gets the branch it is viewing, or all.
    const { ids: branchIds, limited: branchLimited, allowed: allowedBranchIds } = await effectiveBranchIds(svc.admin, data.user.id, permissions, role, req.headers['x-branch-ids']);

    req.tenant = {
      slug,
      // A login limited to some branches acts with its own token, so the database applies every
      // rule to it (the service key would skip row security). The owner keeps the service client,
      // narrowed for reports to the branch it is viewing.
      admin: branchLimited ? svc.asUser(token, branchIds) : branchIds ? svc.scoped(branchIds) : svc.admin,
      branchIds,
      allowedBranchIds,
      service: svc.admin,
      projectUrl: svc.projectUrl,
      userId: data.user.id,
      email: data.user.email ?? null,
      role,
      permissions,
      portalId: meta.kind === 'portal' && typeof meta.portal_id === 'string' ? meta.portal_id : null,
    };
    runWithCurrency(currency, () => next());
  };
}
