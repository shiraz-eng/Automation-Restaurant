import { createServerClient, type CookieOptions } from '@supabase/ssr';
import { cookies } from 'next/headers';

type CookieToSet = { name: string; value: string; options: CookieOptions };

const URL = process.env.NEXT_PUBLIC_CONTROL_PLANE_URL!;
const ANON = process.env.NEXT_PUBLIC_CONTROL_PLANE_ANON_KEY!;

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
