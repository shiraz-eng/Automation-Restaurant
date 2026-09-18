import { notFound, redirect } from 'next/navigation';
import { createTenantServerClient } from '@/lib/supabase/tenant-server';
import { PortalProvider } from '@/components/PortalProvider';
import { SignOutButton } from '@/components/SignOutButton';
import { NavLink } from '@/components/NavLink';
import { ThemeProvider } from '@/components/ThemeProvider';
import { roleHome } from '@/lib/portals';
import { can } from '@/lib/permissions';
import { themeFromBrandKit, type BrandKit } from '@/lib/theme';

// [segment, label, permission key, ownerOnly]. Items without a key always
// show. The permission gate is additive to the role gate below —
// owner/manager with an empty (legacy) array see everything; a real,
// configured array hides what it lacks. ownerOnly is a SEPARATE,
// defense-in-depth exclusion: these sections never render for a
// non-owner even if the underlying permission were somehow granted
// (restaurant.delete / ownership transfer / roles+permissions
// administration / billing / the refund-approval policy itself) —
// matching the governing spec's "Owner-only capabilities cannot be
// granted through Manager portal configuration". The real enforcement
// is still server-side (RLS + protect_owner_only_permissions trigger on
// public.roles); this only keeps the nav honest about it, per "UI hiding
// is not security" — the point is these routes ALSO reject a manager
// server-side (gatePortalPage/RLS), not that hiding the link is enough.
const NAV: [string, string, string?, boolean?][] = [
  ['', 'Dashboard'],
  ['exceptions', 'Attention', 'orders.view'],
  ['approvals', 'Approvals', 'ai.approve_sensitive_action'],
  ['live', 'Live ops', 'orders.view'],
  ['checkout', 'Checkout', 'payments.view'],
  ['close', 'Day close', 'finance.view'],
  ['expenses', 'Expenses', 'finance.view'],
  ['kds', 'Kitchen Display', 'kitchen.view'],
  ['tables', 'Tables & QR', 'tables.view'],
  ['reservations', 'Reservations', 'tables.view'],
  ['orders', 'Orders', 'orders.view'],
  ['menu', 'Menu', 'menu.view'],
  ['deals', 'Deals', 'deals.view'],
  ['promotions', 'Promotions', 'menu.view'],
  ['inventory', 'Inventory', 'stock.view'],
  ['recipes', 'Recipes & Food Cost', 'menu.view'],
  ['suppliers', 'Suppliers', 'supplier.view'],
  ['purchasing', 'Purchasing', 'purchases.view'],
  ['staff', 'Staff', 'staff.view'],
  ['scheduling', 'Shifts', 'attendance.view'],
  ['portals', 'Kiosk Portals', 'portals.view', true],
  ['audit', 'Audit log', 'reports.view'],
  ['exports', 'Export History', 'reports.view'],
  ['ai', 'Assistant', 'ai.view'],
  ['social', 'Social', 'social.view'],
  ['billing', 'Billing', 'settings.view', true],
  ['settings/theme', 'Brand Kit', 'settings.view'],
  ['settings/policies', 'Policies', 'settings.view', true],
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

  // Operations Portal. A portal login goes to its own portal; roles with a
  // dedicated surface (chef → kitchen, cashier → register, …) are bounced there;
  // owner/manager and any permissioned role without a dedicated home may use
  // Operations, gated per-page by permission.
  const meta = (user.app_metadata ?? {}) as {
    kind?: string;
    role?: string;
    portal_route?: string;
    permissions?: string[];
  };
  if (meta.kind === 'portal') {
    redirect(meta.portal_route ? `/r/${slug}/portal/${meta.portal_route}` : `/r/${slug}/login`);
  }
  const role = meta.role ?? 'owner';
  const home = roleHome(role, slug);
  if (home !== `/r/${slug}`) redirect(home);

  const perms = Array.isArray(meta.permissions) ? meta.permissions : [];
  const canSee = (key?: string, ownerOnly?: boolean) => (!ownerOnly || role === 'owner') && (!key || can(perms, role, key));

  // Brand Kit — resolved once per request from this restaurant's own
  // authenticated session (never a client-supplied slug/id), same RPC the
  // guest storefront uses, so there is exactly one Brand Kit->theme path.
  const { data: brandKitRows } = await t.client.rpc('get_brand_kit');
  const brandKit = (Array.isArray(brandKitRows) ? brandKitRows[0] : brandKitRows) as BrandKit | null;
  const initialTheme = themeFromBrandKit(brandKit ?? null);
  const logoUrl = brandKit?.logo_url ?? null;

  return (
    <PortalProvider
      value={{ slug, supabaseUrl: t.config.url, supabaseAnonKey: t.config.anonKey }}
    >
    <ThemeProvider initialTheme={initialTheme} storageKey={`ar-theme:${slug}`} scoped>
      <div className="min-h-screen flex">
        <aside className="hidden md:flex md:flex-col w-60 shrink-0 border-r border-border bg-surface p-5">
          {logoUrl && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={logoUrl} alt={`${t.config.restaurantName} logo`} className="h-10 max-w-[9rem] object-contain mb-3" />
          )}
          <div className="font-black text-lg leading-tight">{t.config.restaurantName}</div>
          <div className="text-muted text-[11px] mb-1">
            /{slug}
            {t.config.tier ? ` · ${t.config.tier}` : ''}
          </div>
          <div className="text-[10px] font-bold uppercase tracking-wide text-primary mb-6">
            {role === 'owner' ? 'Owner Admin' : 'Manager Portal'}
          </div>
          <nav className="flex flex-col gap-1 text-sm">
            {NAV.filter(([, , key, ownerOnly]) => canSee(key, ownerOnly)).map(([seg, label]) => (
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
    </ThemeProvider>
    </PortalProvider>
  );
}
