import { notFound, redirect } from 'next/navigation';
import { createTenantServerClient } from '@/lib/supabase/tenant-server';
import { PortalProvider } from '@/components/PortalProvider';
import { SignOutButton } from '@/components/SignOutButton';

export const dynamic = 'force-dynamic';

export default async function PortalLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ slug: string; portalKey: string }>;
}) {
  const { slug, portalKey } = await params;
  const t = await createTenantServerClient(slug);
  if (!t) notFound();

  const {
    data: { user },
  } = await t.client.auth.getUser();
  if (!user) redirect(`/r/${slug}/login`);

  const { data: portal } = await t.client
    .from('portals')
    .select('id, name, type, route_key, status, permissions, force_pw_change')
    .eq('route_key', portalKey)
    .maybeSingle();
  if (!portal) notFound();

  const meta = (user.app_metadata ?? {}) as {
    kind?: string;
    portal_id?: string;
    permissions?: string[];
  };
  const perms = meta.permissions ?? [];
  const isOwner = perms.includes('*') || perms.includes('portals.view');
  const isThisPortal = meta.kind === 'portal' && meta.portal_id === portal.id;

  // A portal user may only enter its own portal; an admin may preview any.
  if (!isThisPortal && !isOwner) {
    redirect(`/r/${slug}/login`);
  }
  if (portal.status === 'disabled' && !isOwner) {
    redirect(`/r/${slug}/login`);
  }
  // Force a password change on first sign-in for a freshly-created portal login.
  if (isThisPortal && portal.force_pw_change) {
    redirect(`/r/${slug}/set-portal-password?p=${portalKey}`);
  }

  return (
    <PortalProvider
      value={{ slug, supabaseUrl: t.config.url, supabaseAnonKey: t.config.anonKey }}
    >
      <div className="min-h-screen flex flex-col bg-main">
        <header className="flex items-center justify-between px-5 h-14 border-b border-border bg-surface shrink-0">
          <div className="flex items-baseline gap-3">
            <span className="font-black">{t.config.restaurantName}</span>
            <span className="text-xs font-bold uppercase tracking-wider text-primary">
              {portal.name}
            </span>
            {portal.status === 'disabled' && (
              <span className="text-[10px] font-bold text-danger">DISABLED</span>
            )}
          </div>
          <div className="flex items-center gap-3 text-xs text-muted">
            <span className="hidden sm:inline">{user.email}</span>
            <SignOutButton redirectTo={`/r/${slug}/login`} />
          </div>
        </header>
        <main className="flex-1 p-4 md:p-8">{children}</main>
      </div>
    </PortalProvider>
  );
}
