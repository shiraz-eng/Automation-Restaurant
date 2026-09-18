import { redirect } from 'next/navigation';
import type { SupabaseClient, User } from '@supabase/supabase-js';

/**
 * Client-side permission check for hiding UI (nav visibility, page-level
 * redirects) — the real enforcement is the tenant RLS policies + the
 * API's requirePortalPerm middleware (routes/staff.ts's permits(),
 * apps/api/src/middleware/portalAuth.ts), which this mirrors exactly:
 * owner is unconditional (permissions always includes '*' — see
 * provisioning.ts), manager passes ONLY when its permissions array is
 * genuinely empty (the same narrow "no explicit permissions assigned
 * yet" legacy case has_perm()/permits() fall back on — real, freshly
 * created accounts now always get a real array from routes/staff.ts, so
 * this case is legacy-tenant compatibility, not a standing bypass).
 * Once a manager has an actual (possibly restricted) permissions array —
 * the Owner's Portal & Access Control configuration — it's held to that
 * array exactly like every other role, never auto-passed by role name.
 */
export function can(perms: string[], role: string, key: string): boolean {
  if (perms.includes('*')) return true;
  if (perms.length === 0 && (role === 'owner' || role === 'manager')) return true;
  return key !== '' && perms.includes(key);
}

/**
 * Server-only guard for an Operations Portal page. Redirects to login when
 * signed out, or to the dashboard when the caller lacks `key` (pass '' for
 * pages that only need a signed-in user). Returns the user + resolved claims.
 *
 * `ownerOnly: true` adds a hard, permission-independent requirement that
 * the caller's role be literally 'owner' — for the small set of pages
 * (Roles & Access Control, Kiosk Portals, Billing, Policies) that must
 * never be reachable by a manager even if role.update/settings.update
 * were somehow granted to them. This is the same list layout.tsx's NAV
 * array marks ownerOnly, enforced here too since hiding the link is not
 * itself the security boundary.
 */
export async function gatePortalPage(
  client: SupabaseClient,
  slug: string,
  key: string,
  opts?: { ownerOnly?: boolean },
): Promise<{ user: User; role: string; perms: string[] }> {
  const {
    data: { user },
  } = await client.auth.getUser();
  if (!user) redirect(`/r/${slug}/login`);

  const meta = (user.app_metadata ?? {}) as {
    kind?: string;
    role?: string;
    portal_route?: string;
    permissions?: string[];
  };
  // A portal login belongs in its own portal, never the Operations app.
  if (meta.kind === 'portal') {
    redirect(meta.portal_route ? `/r/${slug}/portal/${meta.portal_route}` : `/r/${slug}/login`);
  }
  const role = meta.role ?? 'owner';
  const perms = Array.isArray(meta.permissions) ? meta.permissions : [];

  if (opts?.ownerOnly && role !== 'owner') redirect(`/r/${slug}`);
  if (key !== '' && !can(perms, role, key)) redirect(`/r/${slug}`);
  return { user, role, perms };
}
