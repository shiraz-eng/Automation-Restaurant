import type { Request, Response, NextFunction } from 'express';
import type { SupabaseClient } from '@supabase/supabase-js';
import { tenantServiceClientBySlug } from '../lib/tenantAdmin';

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

    const svc = await tenantServiceClientBySlug(slug);
    if (!svc) return res.status(404).json({ error: 'restaurant_not_found' });

    const { data, error } = await svc.admin.auth.getUser(token);
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
        .json({ error: 'forbidden', message: "You don't have permission to perform this action." });
    }

    req.tenant = {
      slug,
      admin: svc.admin,
      projectUrl: svc.projectUrl,
      userId: data.user.id,
      email: data.user.email ?? null,
      role,
      permissions,
      portalId: meta.kind === 'portal' && typeof meta.portal_id === 'string' ? meta.portal_id : null,
    };
    next();
  };
}
