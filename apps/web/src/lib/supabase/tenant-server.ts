import { createServerClient, type CookieOptions } from '@supabase/ssr';
import { cookies } from 'next/headers';
import { getTenantConfig, type TenantConfig } from '@/lib/tenant';
import { tenantCookiePath } from './cookieScope';
import { BRANCH_COOKIE, branchHeaderFrom } from '@/lib/branchScope';

type CookieToSet = { name: string; value: string; options: CookieOptions };

/**
 * Supabase client for Server Components, bound to a specific restaurant's
 * project and the caller's session. Returns null if the slug is unknown or not
 * yet provisioned. Supabase derives the auth cookie name from the project ref
 * in the URL, so two restaurants' sessions don't collide in one browser.
 */
export async function createTenantServerClient(slug: string) {
  const config = await getTenantConfig(slug);
  if (!config) return null;
  return { client: build(config, await cookies(), slug), config };
}

function build(config: TenantConfig, cookieStore: Awaited<ReturnType<typeof cookies>>, slug: string) {
  // The branch being worked in (branchScope.ts) — narrows every query; never widens access.
  const branch = branchHeaderFrom(cookieStore.get(BRANCH_COOKIE)?.value);
  return createServerClient(config.url, config.anonKey, {
    cookieOptions: { path: tenantCookiePath(slug) },
    ...(branch ? { global: { headers: { 'x-branch-ids': branch } } } : {}),
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet: CookieToSet[]) {
        try {
          cookiesToSet.forEach(({ name, value, options }) =>
            cookieStore.set(name, value, options),
          );
        } catch {
          // Server Component context — writes happen in middleware.
        }
      },
    },
  });
}
