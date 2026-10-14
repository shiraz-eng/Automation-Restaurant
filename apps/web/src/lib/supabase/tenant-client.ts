import { createBrowserClient } from '@supabase/ssr';
import { currentCookieName, currentCookiePath } from './cookieScope';

/** Browser Supabase client for a specific restaurant's project. The url + anon
 *  key are passed down from the server component that already resolved them.
 *  Its session cookie is scoped to this restaurant's /r/<slug> pages. */
export function createTenantBrowserClient(url: string, anonKey: string, branchId?: string | null) {
  return createBrowserClient(url, anonKey, {
    // Path and name follow the page's session slot (cookieScope.ts), so tabs of different
    // slots never share a session or the cross-tab sync channel.
    cookieOptions: { path: currentCookiePath(), ...(currentCookieName(url) ? { name: currentCookieName(url) } : {}) },
    // The branch being worked in (lib/branchScope.ts); the database decides what it may see.
    ...(branchId ? { global: { headers: { 'x-branch-ids': branchId } } } : {}),
  });
}
