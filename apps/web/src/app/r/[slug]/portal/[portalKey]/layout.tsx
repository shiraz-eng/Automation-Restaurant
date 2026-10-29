import { AccessibilityMenu } from '@/components/AccessibilityMenu';
import { LanguageMenu } from '@/components/LanguageMenu';
import { UiTranslator } from '@/components/UiTranslator';
import { notFound, redirect } from 'next/navigation';
import { createTenantServerClient } from '@/lib/supabase/tenant-server';
import { PortalProvider } from '@/components/PortalProvider';
import { SignOutButton } from '@/components/SignOutButton';
import { IdleSignOut } from '@/components/IdleSignOut';
import { portalAccess, type PortalLoginMeta } from '@/lib/portalAccess';
import { fetchPortalTheme } from '@/lib/theme';

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

  // The portal's own login, or a staff login previewing it — never another station's login.
  const { allowed, isThisPortal, mustSetPassword } = portalAccess((user.app_metadata ?? {}) as PortalLoginMeta, portal);
  if (!allowed) redirect(`/r/${slug}/login`);
  // Force a password change on first sign-in for a freshly-created portal login.
  if (mustSetPassword) redirect(`/r/${slug}/set-portal-password?p=${portalKey}`);

  // Logo only — the theme itself is now applied once, by the tenant root
  // layout (apps/web/src/app/r/[slug]/layout.tsx) that wraps this page.
  const { logoUrl } = await fetchPortalTheme(t.client);
  // Idle sign-out for shared station devices (tenant-migrations/0111). Read on its own so a
  // restaurant without the column (an error here) simply has none.
  const { data: idle } = isThisPortal
    ? await t.client.from('portals').select('idle_minutes').eq('id', portal.id).maybeSingle()
    : { data: null };
  const idleMinutes = Number((idle as { idle_minutes?: number | null } | null)?.idle_minutes) || 0;

  return (
    <PortalProvider
      expectedUserId={user.id}
      value={{ slug, supabaseUrl: t.config.url, supabaseAnonKey: t.config.anonKey }}
    >
      <UiTranslator slug={slug} />
      {idleMinutes > 0 && <IdleSignOut minutes={idleMinutes} redirectTo={`/r/${slug}/login`} />}
      <a href="#main-content" className="skip-link">
        Skip to main content
      </a>
      <div className="min-h-screen flex flex-col bg-main">
        <header className="flex items-center justify-between gap-3 px-4 sm:px-5 h-14 border-b border-border bg-surface shrink-0">
          <div className="flex min-w-0 items-baseline gap-2 sm:gap-3">
            {logoUrl && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={logoUrl} alt={`${t.config.restaurantName} logo`} className="h-8 max-w-[6rem] shrink-0 self-center object-contain" />
            )}
            <span translate="no" className="min-w-0 truncate font-black">{t.config.restaurantName}</span>
            <span className="min-w-0 truncate text-xs font-bold uppercase tracking-wider text-primary">
              {portal.name}
            </span>
            {portal.status === 'disabled' && (
              <span className="text-[0.625rem] font-bold text-danger">⚠ DISABLED</span>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-2 sm:gap-3 text-xs text-muted">
            <LanguageMenu />
            <AccessibilityMenu />
            <span className="hidden sm:inline">{user.email}</span>
            <SignOutButton redirectTo={`/r/${slug}/login`} />
          </div>
        </header>
        <main id="main-content" tabIndex={-1} className="flex-1 min-w-0 p-4 md:p-8 focus:outline-none">
          {children}
        </main>
      </div>
    </PortalProvider>
  );
}
