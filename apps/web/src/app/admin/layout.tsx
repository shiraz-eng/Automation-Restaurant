import Link from 'next/link';
import {
  ChefHat,
  LayoutDashboard,
  BarChart3,
  FileText,
  Users2,
  Store,
  ShieldCheck,
  Repeat,
  CreditCard,
  Receipt,
  Settings as SettingsIcon,
} from 'lucide-react';
import { createControlPlaneServerClient } from '@/lib/supabase/control-plane-server';
import { canAdmin } from '@/lib/adminPermissions';
import { AdminSignOut } from './AdminSignOut';

type NavItem = readonly [href: string, label: string, icon: React.ComponentType<{ size?: number }>, perm: string];
type NavGroup = { header: string; items: readonly NavItem[] };

const NAV: readonly NavGroup[] = [
  {
    header: 'Overview',
    items: [
      ['/admin', 'Overview', LayoutDashboard, 'dashboard.view'],
      ['/admin/analytics', 'Analytics', BarChart3, 'analytics.view'],
    ],
  },
  {
    header: 'Content',
    items: [['/admin/cms', 'CMS', FileText, 'cms.manage']],
  },
  {
    header: 'Accounts',
    items: [
      ['/admin/customers', 'Customers', Users2, 'customers.view'],
      ['/admin/restaurants', 'Restaurants', Store, 'restaurants.view'],
      ['/admin/users', 'Users', ShieldCheck, 'users.manage'],
    ],
  },
  {
    header: 'Billing',
    items: [
      ['/admin/subscriptions', 'Subscriptions', Repeat, 'subscriptions.view'],
      ['/admin/subscriptions/plans', 'Plans & Pricing', CreditCard, 'plans.manage'],
      ['/admin/subscriptions/invoices', 'Invoices', Receipt, 'invoices.view'],
    ],
  },
  {
    header: 'Platform',
    items: [['/admin/settings', 'Settings', SettingsIcon, 'settings.manage']],
  },
] as const;

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createControlPlaneServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const meta = user?.app_metadata as { role?: string; permissions?: string[] } | undefined;
  const role = meta?.role ?? '';
  const perms = Array.isArray(meta?.permissions) ? meta!.permissions! : [];
  const isPlatformAdmin = role === 'super_admin' || perms.length > 0;

  // No redirect here — /admin/login is itself nested under this layout, so
  // redirecting unauthenticated visitors to /admin/login from here would
  // send them right back into this same check, forever. Every individual
  // admin page already re-checks auth itself (gateAdminPage) and is the
  // real gate; this layout just skips its own chrome when logged out so
  // the login page renders cleanly instead of looping.
  if (!user || !isPlatformAdmin) return <div className="min-h-screen bg-ink text-ink-fg">{children}</div>;

  const groups = NAV.map((g) => ({ ...g, items: g.items.filter(([, , , perm]) => canAdmin(perms, role, perm)) })).filter(
    (g) => g.items.length > 0,
  );
  const flatItems = groups.flatMap((g) => g.items);

  return (
    <div className="min-h-screen flex bg-ink text-ink-fg">
      <aside className="hidden md:flex md:flex-col w-60 shrink-0 border-r border-white/10 bg-black/30">
        <div className="p-5 pb-4">
          <Link href="/admin" className="flex items-center gap-2.5">
            <span className="flex h-8 w-8 items-center justify-center rounded-full bg-gold text-ink">
              <ChefHat size={16} strokeWidth={2.5} />
            </span>
            <span className="flex items-baseline gap-1">
              <span className="font-black text-sm">Automation</span>
              <span className="text-gold text-lg leading-none">.</span>
            </span>
          </Link>
          <div className="mt-1 text-[10px] font-bold uppercase tracking-[0.14em] text-ink-muted">Platform Administration</div>
        </div>
        <nav className="flex-1 flex flex-col gap-3 px-3 overflow-y-auto">
          {groups.map((g) => (
            <div key={g.header}>
              <div className="px-3 pb-1 text-[10px] font-bold uppercase tracking-[0.1em] text-ink-muted/70">{g.header}</div>
              <div className="flex flex-col gap-0.5">
                {g.items.map(([href, label, Icon]) => (
                  <Link
                    key={href}
                    href={href}
                    className="flex items-center gap-2.5 rounded-lg px-3 py-2 text-xs font-semibold text-ink-muted hover:bg-white/5 hover:text-ink-fg transition-colors"
                  >
                    <Icon size={15} />
                    {label}
                  </Link>
                ))}
              </div>
            </div>
          ))}
        </nav>
        <div className="p-3 border-t border-white/10 flex items-center justify-between gap-2">
          <span className="text-[11px] text-ink-muted truncate">{user.email}</span>
          <AdminSignOut />
        </div>
      </aside>

      <div className="flex-1 flex flex-col min-w-0">
        <header className="md:hidden flex items-center justify-between px-5 h-14 border-b border-white/10 bg-black/30 shrink-0">
          <Link href="/admin" className="flex items-baseline gap-2">
            <span className="font-black text-sm">Automation</span>
            <span className="text-gold">.</span>
          </Link>
          <AdminSignOut />
        </header>
        <nav className="md:hidden flex items-center gap-3 px-5 py-2 border-b border-white/10 bg-black/30 text-xs font-semibold text-ink-muted overflow-x-auto">
          {flatItems.map(([href, label]) => (
            <Link key={href} href={href} className="whitespace-nowrap hover:text-ink-fg">
              {label}
            </Link>
          ))}
        </nav>
        <main className="flex-1 p-6 md:p-10 overflow-x-hidden">{children}</main>
      </div>
    </div>
  );
}
