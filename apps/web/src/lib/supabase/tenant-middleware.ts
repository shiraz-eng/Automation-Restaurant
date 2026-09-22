import { createServerClient, type CookieOptions } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';

type CookieToSet = { name: string; value: string; options: CookieOptions };

const CP_URL = process.env.NEXT_PUBLIC_CONTROL_PLANE_URL!;
const CP_ANON = process.env.NEXT_PUBLIC_CONTROL_PLANE_ANON_KEY!;

async function tenantConfig(slug: string): Promise<{ url: string; anonKey: string } | null> {
  try {
    const res = await fetch(
      `${CP_URL}/rest/v1/tenant_directory?slug=eq.${encodeURIComponent(slug)}&select=project_url,anon_key`,
      { headers: { apikey: CP_ANON, Authorization: `Bearer ${CP_ANON}` } },
    );
    if (!res.ok) return null;
    const rows = (await res.json()) as { project_url: string; anon_key: string }[] | null;
    const row = rows?.[0];
    return row ? { url: row.project_url, anonKey: row.anon_key } : null;
  } catch {
    return null;
  }
}

/** Refreshes a Supabase session cookie for `url`/`anonKey` against `request`,
 *  returns { response, user }. */
async function refresh(request: NextRequest, url: string, anonKey: string) {
  let response = NextResponse.next({ request });
  const supabase = createServerClient(url, anonKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet: CookieToSet[]) {
        cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
        response = NextResponse.next({ request });
        cookiesToSet.forEach(({ name, value, options }) =>
          response.cookies.set(name, value, options),
        );
      },
    },
  });
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return { response, user };
}

/** Gates /r/<slug>/... and /admin/... : refreshes the right session and
 *  redirects unauthenticated users to the matching login page. */
export async function updateTenantSession(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // ── Platform super-admin area ──
  if (pathname === '/admin' || pathname.startsWith('/admin/')) {
    const isLogin = pathname === '/admin/login';
    const { response, user } = await refresh(request, CP_URL, CP_ANON);
    const meta = user?.app_metadata as { role?: string; permissions?: string[] } | undefined;
    const role = meta?.role;
    // A granular platform admin (any role with a non-empty permissions
    // array) is let through the edge — the real per-page gate is
    // gateAdminPage(), which checks the SPECIFIC permission that page
    // needs, not just "is this a platform admin at all".
    const isPlatformAdmin = role === 'super_admin' || (Array.isArray(meta?.permissions) && meta!.permissions!.length > 0);
    if ((!user || !isPlatformAdmin) && !isLogin) {
      const u = request.nextUrl.clone();
      u.pathname = '/admin/login';
      return NextResponse.redirect(u);
    }
    if (user && isPlatformAdmin && isLogin) {
      const u = request.nextUrl.clone();
      u.pathname = '/admin';
      return NextResponse.redirect(u);
    }
    return response;
  }

  // ── Per-restaurant portals ──
  const match = pathname.match(/^\/r\/([^/]+)(\/.*)?$/);
  if (!match) return NextResponse.next({ request });

  const slug = match[1];
  const rest = match[2] ?? '';
  const isLogin = rest === '/login' || rest === '/login/';

  const config = await tenantConfig(slug);
  if (!config) return NextResponse.next({ request });

  const { response, user } = await refresh(request, config.url, config.anonKey);
  if (!user && !isLogin) {
    const u = request.nextUrl.clone();
    u.pathname = `/r/${slug}/login`;
    return NextResponse.redirect(u);
  }
  if (user && isLogin) {
    const u = request.nextUrl.clone();
    u.pathname = `/r/${slug}`;
    return NextResponse.redirect(u);
  }
  return response;
}
