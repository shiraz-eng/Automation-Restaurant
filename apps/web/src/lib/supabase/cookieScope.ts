/**
 * Where each Supabase session cookie lives. Every restaurant is its own
 * Supabase project, so each one a person signs into adds a ~3–4 KB auth
 * cookie. Left at path "/", the browser sends ALL of them on every request
 * and the site eventually rejects the request (494 REQUEST_HEADER_TOO_LARGE).
 * Scoping a restaurant's session to /r/<slug> (and the platform session to
 * /admin) means a request only ever carries the one session it needs.
 */
export const ADMIN_COOKIE_PATH = '/admin';

export function tenantCookiePath(slug: string): string {
  return `/r/${slug}`;
}

/** Browser only: the cookie path for the page currently open. */
export function currentCookiePath(): string {
  if (typeof window === 'undefined') return '/';
  const { pathname } = window.location;
  const tenant = pathname.match(/^\/r\/[^/]+/);
  if (tenant) return tenant[0];
  if (pathname === ADMIN_COOKIE_PATH || pathname.startsWith(`${ADMIN_COOKIE_PATH}/`)) return ADMIN_COOKIE_PATH;
  return '/';
}
