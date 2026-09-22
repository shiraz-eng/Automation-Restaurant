import type { Metadata } from 'next';
import { createTenantServerClient } from '@/lib/supabase/tenant-server';
import { ThemeProvider } from '@/components/ThemeProvider';
import { fetchPortalTheme } from '@/lib/theme';
import { buildPortalMetadata } from '@/lib/portalMetadata';

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  return buildPortalMetadata(slug);
}

/**
 * Wraps EVERY route under /r/[slug]/* — the staff/owner portal, generated
 * kiosk portals, the dedicated role portals (kitchen/floor/finance/
 * deliveries/register/team), the login page, and the portal-password-setup
 * page — in exactly one Brand Kit-derived theme and one restaurant identity
 * (browser title/favicon). A nested layout no longer fetches or applies its
 * own theme (that would double-apply the identical Brand Kit); it only
 * renders the logo where it wants one, using the same fetchPortalTheme.
 */
export default async function TenantLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const t = await createTenantServerClient(slug);
  const initialTheme = t ? (await fetchPortalTheme(t.client)).initialTheme : undefined;

  return (
    <ThemeProvider initialTheme={initialTheme} storageKey={`ar-theme:${slug}`} scoped persist={false}>
      {children}
    </ThemeProvider>
  );
}
