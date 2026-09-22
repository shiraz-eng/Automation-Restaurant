import type { Request, Response, NextFunction } from 'express';
import { supabaseAdmin } from '../supabase';

/** Platform-admin context attached by requireSuperAdminPerm(). */
export type PlatformAdminContext = {
  userId: string;
  email: string | null;
  role: string | null;
  permissions: string[];
};

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      admin?: PlatformAdminContext;
    }
  }
}

/** Does this caller hold `need`? super_admin and '*' are unconditional. */
export function permitsAdmin(perms: string[], role: string | null, need: string): boolean {
  if (role === 'super_admin') return true;
  return perms.includes('*') || perms.includes(need);
}

/**
 * Express middleware: verify the caller's control-plane JWT (Authorization:
 * Bearer …) and require the `need` platform permission. On success attaches
 * req.admin. This is the real boundary — the UI hiding a nav item/button is
 * never the check.
 */
export function requireSuperAdminPerm(need: string) {
  return async function adminPermGuard(req: Request, res: Response, next: NextFunction) {
    const auth = req.headers.authorization;
    if (!auth?.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'missing_token' });
    }
    const { data, error } = await supabaseAdmin.auth.getUser(auth.slice(7));
    if (error || !data?.user) {
      return res.status(401).json({ error: 'session_expired' });
    }

    const meta = (data.user.app_metadata ?? {}) as { role?: string; permissions?: string[] };
    const permissions = Array.isArray(meta.permissions) ? meta.permissions : [];
    const role = meta.role ?? null;

    if (role !== 'super_admin') {
      // Re-check platform_admins.status so a disabled admin is blocked
      // even before their JWT's cached app_metadata refreshes.
      const { data: rec } = await supabaseAdmin
        .from('platform_admins')
        .select('status')
        .eq('user_id', data.user.id)
        .maybeSingle();
      if (!rec || rec.status !== 'active') {
        return res.status(403).json({ error: 'forbidden', message: 'Your admin access is not active.' });
      }
    }

    if (!permitsAdmin(permissions, role, need)) {
      return res
        .status(403)
        .json({ error: 'forbidden', message: "You don't have permission to perform this action." });
    }

    req.admin = { userId: data.user.id, email: data.user.email ?? null, role, permissions };
    next();
  };
}
