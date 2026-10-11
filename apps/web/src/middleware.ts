import { type NextRequest } from 'next/server';
import { updateTenantSession } from '@/lib/supabase/tenant-middleware';

export async function middleware(request: NextRequest) {
  return updateTenantSession(request);
}

export const config = {
  // Every page (not static files or the Next.js internals): /r/* and /admin refresh their
  // session; any other page only clears site-wide sign-in cookies (tenant-middleware.ts).
  matcher: ['/((?!_next/|favicon|.*\\.(?:png|jpg|jpeg|svg|webp|ico|css|js|map|txt|xml)$).*)'],
};
