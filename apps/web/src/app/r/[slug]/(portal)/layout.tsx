import { notFound, redirect } from 'next/navigation';
import { createTenantServerClient } from '@/lib/supabase/tenant-server';
import { PortalProvider } from '@/components/PortalProvider';
import { SignOutButton } from '@/components/SignOutButton';
import { NavLink } from '@/components/NavLink';
import { roleHome } from '@/lib/portals';
import { can } from '@/lib/permissions';
import { fetchPortalTheme } from '@/lib/theme';
import type { FeatureKey } from '@automation-restaurant/shared';

// [segment, label, permission key, ownerOnly, requiredFeature]. Items without a key always
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
//
// Grouped for the sidebar's category headings — purely a presentation
// grouping over the exact same [segment, label, key, ownerOnly] entries
// and routes as before; no route or permission here is new.
type NavItem = [string, string, string?, boolean?, FeatureKey?];
const NAV_GROUPS: [string, NavItem[]][] = [
  ['Main', [['', 'Dashboard']]],
  [
    'Operations',
    [
      ['exceptions', 'Attention', 'orders.view'],
      ['approvals', 'Approvals', 'ai.approve_sensitive_action'],
      ['live', 'Live ops', 'orders.view'],
      ['checkout', 'Checkout', 'payments.view'],
      ['close', 'Day close', 'finance.view'],
      ['tables', 'Tables & QR', 'tables.view'],
      ['reservations', 'Reservations', 'tables.view'],
      ['orders', 'Orders', 'orders.view'],
    ],
  ],
  [
    'Kitchen',
    [
      ['kds', 'Kitchen Display', 'kitchen.view'],
      ['kds/history', 'KOT History', 'kitchen.view'],
    ],
  ],
  [
    'Menu',
    [
      ['menu', 'Menu', 'menu.view'],
      ['deals', 'Deals', 'deals.view'],
      ['promotions', 'Promotions', 'menu.view'],
      ['menu/availability', 'Availability History', 'availability.view'],
      ['menu/priority', 'Priority Allocation', 'availability.view'],
    ],
  ],
  ['Inventory', [['inventory', 'Inventory', 'stock.view']]],
  ['Recipes & Food Cost', [['recipes', 'Recipes & Food Cost', 'menu.view']]],
  [
    'Suppliers & Purchasing',
    [
      ['suppliers', 'Suppliers', 'supplier.view'],
      ['purchasing', 'Purchasing', 'purchases.view'],
    ],
  ],
  [
    'Finance',
    [
      ['expenses', 'Expenses', 'finance.view'],
      ['billing', 'Billing', 'settings.view', true],
    ],
  ],
  ['Marketing & Social', [['social', 'Social', 'social.view']]],
  [
    'Staff',
    [
      ['staff', 'Staff', 'staff.view'],
      ['scheduling', 'Shifts', 'attendance.view'],
      ['portals', 'Kiosk Portals', 'portals.view', true],
    ],
  ],
  [
    'Analytics',
    [
      ['audit', 'Audit log', 'reports.view'],
      ['exports', 'Export History', 'reports.view'],
    ],
  ],
  ['AI Intelligence', [['ai', 'Assistant', 'ai.view']]],
  [
    'Settings',
    [
      ['settings/theme', 'Brand Kit', 'settings.view', false, 'menu.branded'],
      ['settings/policies', 'Policies', 'settings.view', true],
    ],
  ],
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

  // plan_features (0055) — synced from the control-plane subscription, read
  // here under business_settings' existing staff_read policy (no new grant
  // needed). plan_tier being null means sync has never run for this tenant
  // (provisioned before 0055, not yet backfilled) — fail OPEN in that case
  // rather than hiding everything; once synced, even a genuinely-empty
  // features array (Starter has none) is enforced for real. The real
  // backstop for menu.branded either way is the DB trigger, not this nav
  // filter — "UI hiding is not security" applies here too.
  const { data: entitlements } = await t.client.from('business_settings').select('plan_tier, plan_features').eq('id', true).maybeSingle();
  const entitlementsSynced = !!entitlements?.plan_tier;
  const planFeatures = (entitlements?.plan_features ?? []) as FeatureKey[];
  const hasFeature = (feature?: FeatureKey) => !feature || !entitlementsSynced || planFeatures.includes(feature);

  const canSee = (key?: string, ownerOnly?: boolean, feature?: FeatureKey) =>
    (!ownerOnly || role === 'owner') && (!key || can(perms, role, key)) && hasFeature(feature);

  // Logo only — the theme itself is now applied once, by the tenant root
  // layout (apps/web/src/app/r/[slug]/layout.tsx) that wraps this page.
  const { logoUrl } = await fetchPortalTheme(t.client);

  const visibleGroups = NAV_GROUPS.map(([group, items]) => [group, items.filter(([, , key, ownerOnly, feature]) => canSee(key, ownerOnly, feature))] as [string, NavItem[]]).filter(
    ([, items]) => items.length > 0,
  );

  return (
    <PortalProvider
      value={{ slug, supabaseUrl: t.config.url, supabaseAnonKey: t.config.anonKey }}
    >
      <div className="min-h-screen flex bg-main">
        <aside className="hidden md:flex md:flex-col w-64 shrink-0 border-r border-border bg-surface overflow-y-auto">
          <div className="p-5 pb-4">
            {logoUrl && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={logoUrl} alt={`${t.config.restaurantName} logo`} className="h-9 max-w-[9rem] object-contain mb-3" />
            )}
            <div className="font-black text-base leading-tight text-body">{t.config.restaurantName}</div>
            <div className="text-muted text-[11px] mt-0.5">
              /{slug}
              {t.config.tier ? ` · ${t.config.tier}` : ''}
            </div>
            <div className="text-[10px] font-bold uppercase tracking-wide text-primary mt-2">
              {role === 'owner' ? 'Owner Admin' : 'Manager Portal'}
            </div>
          </div>
          <nav className="flex-1 flex flex-col gap-4 px-3 pb-5">
            {visibleGroups.map(([group, items]) => (
              <div key={group}>
                <div className="px-3 mb-1 text-[10px] font-bold uppercase tracking-wider text-muted/70">{group}</div>
                <div className="flex flex-col gap-0.5">
                  {items.map(([seg, label]) => (
                    <NavLink key={seg} href={`/r/${slug}${seg ? `/${seg}` : ''}`} exact={seg === ''}>
                      {label}
                    </NavLink>
                  ))}
                </div>
              </div>
            ))}
          </nav>
          <div className="p-4 border-t border-border text-xs text-muted">
            <div className="mb-2 truncate" title={user.email ?? undefined}>
              {user.email}
            </div>
            <SignOutButton redirectTo={`/r/${slug}/login`} />
          </div>
        </aside>

        <div className="flex-1 min-w-0 flex flex-col">
          <header className="flex items-center justify-between gap-4 border-b border-border bg-surface px-6 md:px-10 h-16 shrink-0">
            <div className="min-w-0">
              <div className="text-[11px] text-muted truncate">
                {t.config.restaurantName} / {role === 'owner' ? 'Owner' : 'Management'}
              </div>
              <div className="font-bold text-body text-sm truncate">Command Center</div>
            </div>
            <div className="flex items-center gap-3 shrink-0">
              <span className="hidden sm:inline-flex items-center gap-1.5 rounded-full border border-border bg-main px-3 py-1 text-[11px] font-semibold text-body">
                <span className="h-1.5 w-1.5 rounded-full bg-ok" />
                {t.config.subscriptionStatus ?? 'Active'}
                {t.config.tier ? ` · ${t.config.tier}` : ''}
              </span>
              <div className="hidden sm:flex items-center gap-2 rounded-full border border-border bg-main pl-1 pr-3 py-1">
                <span className="grid h-6 w-6 place-items-center rounded-full bg-primary text-primary-fg text-[10px] font-bold uppercase">
                  {(user.email ?? '?').slice(0, 1)}
                </span>
                <span className="text-[11px] font-semibold text-body capitalize">{role}</span>
              </div>
            </div>
          </header>
          <main className="flex-1 min-w-0 p-6 md:p-10 bg-main">{children}</main>
        </div>
      </div>
    </PortalProvider>
  );
}
