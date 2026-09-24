import { notFound, redirect } from 'next/navigation';
import { createTenantServerClient } from '@/lib/supabase/tenant-server';
import { PortalProvider } from '@/components/PortalProvider';
import { SignOutButton } from '@/components/SignOutButton';
import { canSeeTeam, roleHome } from '@/lib/portals';
import { fetchPortalTheme } from '@/lib/theme';

export default async function TeamLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const t = await createTenantServerClient(slug);
  if (!t) notFound();
  const {
    data: { user },
  } = await t.client.auth.getUser();
  if (!user) redirect(`/r/${slug}/login`);
  // A portal login has no staff role — without this it would fall through
  // to the 'owner' default below. Send it to its own portal, same as the
  // Operations layout does.
  const portalMeta = user.app_metadata as { kind?: string; portal_route?: string };
  if (portalMeta.kind === 'portal') {
    redirect(portalMeta.portal_route ? `/r/${slug}/portal/${portalMeta.portal_route}` : `/r/${slug}/login`);
  }
  const role = (user.app_metadata as { role?: string }).role ?? 'owner';
  if (!canSeeTeam(role)) redirect(roleHome(role, slug));

  const { logoUrl } = await fetchPortalTheme(t.client);

  return (
    <PortalProvider expectedUserId={user.id} value={{ slug, supabaseUrl: t.config.url, supabaseAnonKey: t.config.anonKey }}>
      <div className="min-h-screen flex flex-col bg-main">
        <header className="flex items-center justify-between px-5 h-14 border-b border-border bg-surface shrink-0">
          <div className="flex items-baseline gap-3">
            {logoUrl && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={logoUrl} alt={`${t.config.restaurantName} logo`} className="h-8 max-w-[6rem] object-contain" />
            )}
            <span className="font-black">{t.config.restaurantName}</span>
            <span className="text-xs font-bold uppercase tracking-wider text-primary">Team</span>
          </div>
          <div className="flex items-center gap-3 text-xs text-muted">
            <span className="hidden sm:inline">{user.email}</span>
            <SignOutButton redirectTo={`/r/${slug}/login`} />
          </div>
        </header>
        <main className="flex-1 p-6 md:p-10">{children}</main>
      </div>
    </PortalProvider>
  );
}
