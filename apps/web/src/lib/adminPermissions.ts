import { redirect } from 'next/navigation';
import type { SupabaseClient, User } from '@supabase/supabase-js';

/**
 * Client-side permission check for the SaaS admin panel — the real
 * enforcement is control-plane RLS (app.has_platform_perm) + the API's
 * requireSuperAdminPerm middleware (apps/api/src/middleware/adminAuth.ts),
 * which this mirrors exactly. Mirrors apps/web/src/lib/permissions.ts's
 * can()/gatePortalPage() for the tenant portal.
 */
export function canAdmin(perms: string[], role: string | null, key: string): boolean {
  if (role === 'super_admin') return true;
  return perms.includes('*') || (key !== '' && perms.includes(key));
}

/**
 * Server-only guard for an admin page. Redirects to /admin/login when
 * signed out, or to /admin when the caller lacks `key` (pass '' for pages
 * that only need a signed-in platform admin). Returns the role + permissions
 * so the caller can further tailor what it renders.
 */
export async function gateAdminPage(
  client: SupabaseClient,
  key: string,
): Promise<{ user: User; role: string; perms: string[] }> {
  const {
    data: { user },
  } = await client.auth.getUser();
  if (!user) redirect('/admin/login');

  const meta = (user.app_metadata ?? {}) as { role?: string; permissions?: string[] };
  const role = meta.role ?? '';
  const perms = Array.isArray(meta.permissions) ? meta.permissions : [];

  if (key !== '' && !canAdmin(perms, role, key)) redirect('/admin');
  return { user, role, perms };
}
