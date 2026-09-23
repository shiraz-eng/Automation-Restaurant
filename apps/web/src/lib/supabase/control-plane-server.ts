import { createServerClient, type CookieOptions } from '@supabase/ssr';
import { cookies } from 'next/headers';

type CookieToSet = { name: string; value: string; options: CookieOptions };

// Public by design (RLS enforces access) — never fall back to a
// service_role key here (see control-plane-client.ts for why).
function requireEnv(value: string | undefined, name: string): string {
  if (!value) throw new Error(`Missing ${name} — set it in the deployment environment.`);
  return value;
}
const URL = requireEnv(
  process.env.NEXT_PUBLIC_CONTROL_PLANE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL,
  'NEXT_PUBLIC_CONTROL_PLANE_URL',
);
const ANON = requireEnv(
  process.env.NEXT_PUBLIC_CONTROL_PLANE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  'NEXT_PUBLIC_CONTROL_PLANE_ANON_KEY',
);

/** Control-plane Supabase client for Server Components (super-admin session). */
export async function createControlPlaneServerClient() {
  const cookieStore = await cookies();
  return createServerClient(URL, ANON, {
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
          // Server Component — cookie writes happen in middleware.
        }
      },
    },
  });
}
