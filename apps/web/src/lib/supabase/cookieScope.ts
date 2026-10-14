/**
 * Where each Supabase session cookie lives. Every restaurant is its own
 * Supabase project, so each one a person signs into adds a ~3–4 KB auth
 * cookie. Left at path "/", the browser sends ALL of them on every request
 * and the site eventually rejects the request (494 REQUEST_HEADER_TOO_LARGE).
 * Scoping a restaurant's session to /r/<slug> (and the platform session to
 * /admin) means a request only ever carries the one session it needs.
 */
import { slotOf } from '../sessionSlot';

export const ADMIN_COOKIE_PATH = '/admin';

export function tenantCookiePath(slug: string): string {
  return `/r/${slug}`;
}

/**
 * The session's cookie name (= Supabase's storageKey) for a /r/<slug> segment. The main
 * panel keeps Supabase's default (undefined); each session slot (lib/sessionSlot.ts) gets
 * its own — not just for the cookie: supabase-js keeps tabs in sync over a BroadcastChannel
 * named after the storage key, so two slots sharing it made each tab's sign-in reload the
 * other, over and over.
 */
export function tenantCookieName(projectUrl: string, slug: string): string | undefined {
  const slot = slotOf(slug);
  if (!slot) return undefined;
  return `sb-${new URL(projectUrl).hostname.split('.')[0]}-auth-token-${slot}`;
}

/** Browser only: the session cookie name for the page currently open. */
export function currentCookieName(projectUrl: string): string | undefined {
  if (typeof window === 'undefined') return undefined;
  const seg = window.location.pathname.match(/^\/r\/([^/]+)/)?.[1];
  return seg ? tenantCookieName(projectUrl, seg) : undefined;
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
