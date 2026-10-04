import { createBrowserClient } from '@supabase/ssr';
import { currentCookiePath } from './cookieScope';

/** Browser Supabase client for a specific restaurant's project. The url + anon
 *  key are passed down from the server component that already resolved them.
 *  Its session cookie is scoped to this restaurant's /r/<slug> pages. */
export function createTenantBrowserClient(url: string, anonKey: string) {
  return createBrowserClient(url, anonKey, { cookieOptions: { path: currentCookiePath() } });
}
