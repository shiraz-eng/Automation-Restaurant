import { createServerClient, type CookieOptions } from '@supabase/ssr';
import { cookies } from 'next/headers';
import { getTenantConfig, type TenantConfig } from '@/lib/tenant';

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
  return { client: build(config, await cookies()), config };
}

function build(config: TenantConfig, cookieStore: Awaited<ReturnType<typeof cookies>>) {
  return createServerClient(config.url, config.anonKey, {
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
