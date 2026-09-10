import { notFound, redirect } from 'next/navigation';
import { createTenantServerClient } from '@/lib/supabase/tenant-server';
import { PortalProvider } from '@/components/PortalProvider';
import { SignOutButton } from '@/components/SignOutButton';
import { NavLink } from '@/components/NavLink';
import { isManagement, roleHome } from '@/lib/portals';

const NAV: [string, string][] = [
  ['', 'Dashboard'],
  ['live', 'Live ops'],
  ['pos', 'Counter POS'],
  ['kds', 'Kitchen Display'],
  ['tables', 'Tables & QR'],
  ['reservations', 'Reservations'],
  ['orders', 'Orders'],
  ['menu', 'Menu'],
  ['promotions', 'Promotions'],
  ['inventory', 'Inventory'],
  ['suppliers', 'Suppliers'],
  ['purchasing', 'Purchasing'],
  ['staff', 'Staff'],
  ['scheduling', 'Shifts'],
  ['portals', 'Portals'],
  ['audit', 'Audit log'],
  ['billing', 'Billing'],
  ['settings/theme', 'Theme'],
];

export default async function PortalLayout({
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

  // This is the management portal. Non-management roles get bounced to theirs.
  const role = (user.app_metadata as { role?: string }).role ?? 'owner';
  if (!isManagement(role)) redirect(roleHome(role, slug));

  return (
    <PortalProvider
      value={{ slug, supabaseUrl: t.config.url, supabaseAnonKey: t.config.anonKey }}
    >
      <div className="min-h-screen flex">
        <aside className="hidden md:flex md:flex-col w-60 shrink-0 border-r border-border bg-surface p-5">
          <div className="font-black text-lg leading-tight">{t.config.restaurantName}</div>
          <div className="text-muted text-[11px] mb-7">
            /{slug}
            {t.config.tier ? ` · ${t.config.tier}` : ''}
          </div>
          <nav className="flex flex-col gap-1 text-sm">
            {NAV.map(([seg, label]) => (
              <NavLink
                key={seg}
                href={`/r/${slug}${seg ? `/${seg}` : ''}`}
                exact={seg === ''}
              >
                {label}
              </NavLink>
            ))}
          </nav>
          <div className="mt-auto pt-6 text-xs text-muted">
            <div className="mb-2 truncate" title={user.email ?? undefined}>
              {user.email}
            </div>
            <SignOutButton redirectTo={`/r/${slug}/login`} />
          </div>
        </aside>
        <main className="flex-1 min-w-0 p-6 md:p-10">{children}</main>
      </div>
    </PortalProvider>
  );
}
