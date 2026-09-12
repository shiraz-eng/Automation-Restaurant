import { notFound, redirect } from 'next/navigation';
import { createTenantServerClient } from '@/lib/supabase/tenant-server';
import { PortalProvider } from '@/components/PortalProvider';
import { SignOutButton } from '@/components/SignOutButton';
import { NavLink } from '@/components/NavLink';
import { roleHome } from '@/lib/portals';
import { can } from '@/lib/permissions';

// [segment, label, permission key]. Items without a key always show. The
// permission gate is additive to the role gate below — owner/manager (and any
// '*' grant) see everything; a scoped permission array hides what it lacks.
const NAV: [string, string, string?][] = [
  ['', 'Dashboard'],
  ['exceptions', 'Attention', 'orders.view'],
  ['approvals', 'Approvals', 'ai.approve_sensitive_action'],
  ['live', 'Live ops', 'orders.view'],
  ['pos', 'Counter POS', 'orders.create'],
  ['checkout', 'Checkout', 'payments.view'],
  ['close', 'Day close', 'finance.view'],
  ['kds', 'Kitchen Display', 'kitchen.view'],
  ['tables', 'Tables & QR', 'tables.view'],
  ['reservations', 'Reservations', 'tables.view'],
  ['orders', 'Orders', 'orders.view'],
  ['menu', 'Menu', 'menu.view'],
  ['deals', 'Deals', 'deals.view'],
  ['promotions', 'Promotions', 'menu.view'],
  ['inventory', 'Inventory', 'stock.view'],
  ['recipes', 'Recipes', 'menu.view'],
  ['suppliers', 'Suppliers', 'supplier.view'],
  ['purchasing', 'Purchasing', 'purchases.view'],
  ['staff', 'Staff', 'staff.view'],
  ['roles', 'Roles', 'roles.view'],
  ['scheduling', 'Shifts', 'attendance.view'],
  ['portals', 'Portals', 'portals.view'],
  ['audit', 'Audit log', 'reports.view'],
  ['ai', 'Assistant', 'ai.view'],
  ['billing', 'Billing', 'settings.view'],
  ['settings/theme', 'Theme', 'settings.view'],
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
  const canSee = (key?: string) => !key || can(perms, role, key);

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
            {NAV.filter(([, , key]) => canSee(key)).map(([seg, label]) => (
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
