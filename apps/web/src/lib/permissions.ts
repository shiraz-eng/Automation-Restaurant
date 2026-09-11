import { redirect } from 'next/navigation';
import type { SupabaseClient, User } from '@supabase/supabase-js';

/**
 * Client-side permission check for hiding UI. The real enforcement is the
 * tenant RLS policies + the API's requirePortalPerm middleware.
 *
 * Transition: owner/manager pass regardless of their permission array, mirroring
 * app.can_write() and the 0006 RLS OR-fallback. A locked-down manager is done
 * with a custom role, not the built-in 'manager' role.
 */
export function can(perms: string[], role: string, key: string): boolean {
  if (role === 'owner' || role === 'manager') return true;
  if (perms.includes('*')) return true;
  return key !== '' && perms.includes(key);
}

/**
 * Server-only guard for an Operations Portal page. Redirects to login when
 * signed out, or to the dashboard when the caller lacks `key` (pass '' for
 * pages that only need a signed-in user). Returns the user + resolved claims.
 */
export async function gatePortalPage(
  client: SupabaseClient,
  slug: string,
  key: string,
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

  if (key !== '' && !can(perms, role, key)) redirect(`/r/${slug}`);
  return { user, role, perms };
}
