import { createBrowserClient } from '@supabase/ssr';
import { currentCookiePath } from './cookieScope';

/** Browser Supabase client for a specific restaurant's project. The url + anon
 *  key are passed down from the server component that already resolved them.
 *  Its session cookie is scoped to this restaurant's /r/<slug> pages. */
export function createTenantBrowserClient(url: string, anonKey: string, branchId?: string | null) {
  return createBrowserClient(url, anonKey, {
    cookieOptions: { path: currentCookiePath() },
    // The branch being worked in (lib/branchScope.ts); the database decides what it may see.
    ...(branchId ? { global: { headers: { 'x-branch-ids': branchId } } } : {}),
  });
}
