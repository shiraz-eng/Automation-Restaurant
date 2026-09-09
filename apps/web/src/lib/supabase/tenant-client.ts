import { createBrowserClient } from '@supabase/ssr';

/** Browser Supabase client for a specific restaurant's project. The url + anon
 *  key are passed down from the server component that already resolved them. */
export function createTenantBrowserClient(url: string, anonKey: string) {
  return createBrowserClient(url, anonKey);
}
