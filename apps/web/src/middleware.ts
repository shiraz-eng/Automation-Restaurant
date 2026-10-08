import { type NextRequest } from 'next/server';
import { updateTenantSession } from '@/lib/supabase/tenant-middleware';

export async function middleware(request: NextRequest) {
  return updateTenantSession(request);
}

export const config = {
  matcher: ['/r/:path*', '/admin', '/admin/:path*'],
};
