import { notFound, redirect } from 'next/navigation';
import { createTenantServerClient } from '@/lib/supabase/tenant-server';
import { PortalProvider } from '@/components/PortalProvider';
import { WorkspaceSwitcher } from '@/components/OwnerBranches';
import { SignOutButton } from '@/components/SignOutButton';
import { ChangePasswordControl } from '@/components/ChangePasswordControl';
import { NavLink } from '@/components/NavLink';
import { roleLabel } from '@/lib/portals';
import { can } from '@/lib/permissions';
import { fetchPortalTheme } from '@/lib/theme';
import { PortalGuideAiWidget } from '@/components/PortalGuideAiWidget';
import { getTenantEntitlement } from '@/lib/entitlements';
import type { FeatureKey } from '@automation-restaurant/shared';
import { LayoutDashboard, type LucideIcon } from 'lucide-react';
import { MODULES, moduleActivePaths, moduleSubNav, toolVisible, visibleTools } from '@/lib/modules';
import { ModuleSubNav } from '@/components/module/ModuleSubNav';
import { ModuleTrail } from '@/components/module/ModuleTrail';

// [segment, label, permission key, ownerOnly, requiredFeature]. Items without a key always
// show. The permission gate is additive to the role gate below —
// owner/manager with an empty (legacy) array see everything; a real,
// configured array hides what it lacks. ownerOnly is a SEPARATE,
// defense-in-depth exclusion: these sections never render for a
// non-owner even if the underlying permission were somehow granted.
//
// Grouped for the sidebar's category headings.
type NavItem = [string, string, string?, boolean?, FeatureKey?];
// A multi-branch restaurant's main panel is the owner's panel only (decision 2026-10-18):
// branches, comparison, the AI, billing, and the defaults new branches start from. Every
// operation — orders, kitchen, menu, stock, staff, finance — runs inside a branch.
const OWNER_PANEL_GROUPS: [string, NavItem[]][] = [
  [
    'Owner panel',
    [
      ['', 'Overview'],
      ['branches', 'Branches', 'branches.view'],
      ['branches/compare', 'Compare branches', 'branches.view'],
    ],
  ],
  ['AI Intelligence', [['ai', 'Assistant', 'ai.view', false, 'analytics.advanced'], ['guide', 'AI Guide']]],
  ['Account', [['billing', 'Billing', 'settings.view', true]]],
  [
    'Defaults for new branches',
    [
      ['settings/theme', 'Brand Kit', 'settings.view', false, 'menu.branded'],
      ['settings/currency', 'Currency', 'settings.view', true],
      ['settings/tax', 'Tax', 'settings.view', true],
    ],
  ],
];

// Everywhere else the sidebar lists modules, not screens: each opens its landing
// page, whose tiles are the module's screens (lib/modules.ts). A module shows
// when at least one of its screens would.
type SideEntry = { key: string; label: string; href: string; icon?: LucideIcon; exact?: boolean; alsoActive?: string[]; feature?: FeatureKey };

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

  // The main portal. A custom-portal login goes to its own portal; every
  // staff login, whatever its role, uses this one — each nav item and page
  // is gated by permission, never by role name.
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

  const perms = Array.isArray(meta.permissions) ? meta.permissions : [];

  // plan_features (0055) — synced from the control-plane subscription, read
  // here under business_settings' existing staff_read policy (no new grant
  // needed). plan_tier being null means sync has never run for this tenant
  // (provisioned before 0055, not yet backfilled) — fail OPEN in that case
  // rather than hiding everything; once synced, even a genuinely-empty
  // features array (Starter has none) is enforced for real. The real
  const ent = await getTenantEntitlement(t.client, t.config.tier);

  // Independent branches (control-plane 0025): this is either the owner's central panel —
  // with the workspace dropdown — or a branch's own workspace, which links back to it.
  const isBranchWorkspace = Boolean(t.config.parentSlug);
  const canSee = (seg: string, key?: string, ownerOnly?: boolean, feature?: FeatureKey) => {
    // A branch's own manager runs its portals; billing and settings stay with the owner.
    const branchManagerMay = isBranchWorkspace && role === 'branch_manager' && seg === 'portals';
    if (ownerOnly && role !== 'owner' && !branchManagerMay) return false;
    if (key && !can(perms, role, key)) return false;
    // For non-owner staff, hide unentitled plan features to keep screens clean
    if (role !== 'owner' && feature && !ent.isEntitled(feature)) return false;
    return true;
  };

  // Logo only — the theme itself is now applied once, by the tenant root
  // layout (apps/web/src/app/r/[slug]/layout.tsx) that wraps this page.
  const { logoUrl } = await fetchPortalTheme(t.client);
  // Branches are managed only from the central panel.
  const showSwitcher = !isBranchWorkspace && (role === 'owner' || perms.includes('*')) && ent.isEntitled('branches.multi');

  const ownerPanelOnly = showSwitcher && role === 'owner';
  // A branch is billed on the main restaurant's plan, so no branch workspace shows Billing.
  const hiddenInBranch = new Set(['branches', 'billing']);
  const base = `/r/${slug}`;
  const href = (seg: string) => `${base}${seg ? `/${seg}` : ''}`;
  const access = { role, perms, isEntitled: ent.isEntitled, isBranchWorkspace };
  const visibleGroups: [string | null, SideEntry[]][] = ownerPanelOnly
    ? OWNER_PANEL_GROUPS.map(([group, items]) => [
        group,
        items
          .filter(([seg, , key, ownerOnly, feature]) => canSee(seg, key, ownerOnly, feature) && !(isBranchWorkspace && hiddenInBranch.has(seg)))
          .map(([seg, label, , , feature]) => ({ key: seg, label, href: href(seg), exact: seg === '', feature })),
      ] as [string, SideEntry[]]).filter(([, items]) => items.length > 0)
    : [
        [
          null,
          [
            ...(canSee('', 'analytics.view') ? [{ key: 'dashboard', label: 'Dashboard', href: href(''), icon: LayoutDashboard, exact: true }] : []),
            ...MODULES.flatMap((m) => {
              const tools = visibleTools(m, access);
              if (tools.length === 0) return [];
              // Locked (plan badge) only when every screen the viewer would see is locked.
              const locked = tools.every((tool) => tool.feature && !ent.isEntitled(tool.feature));
              return [{
                key: m.key,
                label: m.label,
                href: href(m.landing),
                icon: m.icon,
                alsoActive: moduleActivePaths(m).map(href),
                feature: locked ? tools[0].feature : undefined,
              }];
            }),
          ],
        ],
      ];

  // Module sub-navigation bars (lib/modules moduleSubNav), each link filtered with the same
  // gates as its screen. The owner panel keeps its own short sidebar and no bars.
  const subNavs = ownerPanelOnly
    ? []
    : MODULES.map((m) => ({
        key: m.key,
        label: m.label,
        landing: href(m.landing),
        ownedPaths: moduleActivePaths(m).map(href),
        items: moduleSubNav(m).filter((s) => toolVisible(s, access)).map((s) => ({ key: s.key, title: s.title, href: href(s.path) })),
      })).filter((n) => n.items.length > 1);

  return (
    <PortalProvider
      expectedUserId={user.id}
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
              {role === 'owner' ? 'Owner Admin' : `${roleLabel(role)} Portal`}
            </div>
            {showSwitcher && (
              <div className="mt-3">
                <WorkspaceSwitcher slug={slug} />
              </div>
            )}
            {isBranchWorkspace && (
              <div className="mt-3 rounded border border-primary/30 bg-primary/10 px-3 py-2 space-y-1">
                <div className="text-[10px] font-bold uppercase tracking-wide text-muted">Branch workspace · {t.config.branchCode}</div>
                {role === 'owner' && (
                  <a href={`/r/${t.config.parentSlug}`} className="block text-xs font-semibold text-primary hover:underline">
                    ← Back to the owner panel
                  </a>
                )}
              </div>
            )}
          </div>
          <nav className="flex-1 flex flex-col gap-4 px-3 pb-5" aria-label="Main">
            {visibleGroups.map(([group, items]) => (
              <div key={group ?? 'modules'}>
                {group && <div className="px-3 mb-1 text-[10px] font-bold uppercase tracking-wider text-muted/70">{group}</div>}
                <div className="flex flex-col gap-0.5">
                  {items.map(({ key, label, href: to, icon: Icon, exact, alsoActive, feature }) => {
                    const rawBadge = feature && !ent.isEntitled(feature) ? ent.requiredPlanName(feature) : null;
                    const badge = rawBadge === 'Professional' ? 'Pro' : rawBadge;
                    return (
                      <NavLink key={key} href={to} exact={exact} alsoActive={alsoActive}>
                        <span className="flex items-center gap-3 w-full">
                          {Icon && <Icon className="h-[18px] w-[18px] shrink-0" aria-hidden />}
                          <span className="flex-1 truncate">{label}</span>
                          {badge && (
                            <span className="text-[9px] font-extrabold uppercase tracking-wide px-1.5 py-0.5 rounded bg-primary/10 text-primary border border-primary/20">
                              {badge}
                            </span>
                          )}
                        </span>
                      </NavLink>
                    );
                  })}
                </div>
              </div>
            ))}
          </nav>
          <div className="p-4 border-t border-border text-xs text-muted space-y-2">
            <div className="truncate" title={user.email ?? undefined}>
              {user.email}
            </div>
            {/* In a branch only the owner changes passwords: branch logins are set from the owner panel. */}
            {(!isBranchWorkspace || role === 'owner') && <ChangePasswordControl />}
            <SignOutButton redirectTo={`/r/${slug}/login`} />
          </div>
        </aside>

        <div className="flex-1 min-w-0 flex flex-col">
          <header className="flex items-center justify-between gap-4 border-b border-border bg-surface px-6 md:px-10 h-16 shrink-0">
            <div className="min-w-0">
              <div className="text-[11px] text-muted truncate">
                {t.config.restaurantName} / {roleLabel(role)}
              </div>
              <ModuleTrail slug={slug} fallback="Command Center" />
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
          {/* Phones: the sidebar is hidden, so the same entries scroll across under the top bar. */}
          <nav aria-label="Main" className="md:hidden flex gap-1 overflow-x-auto no-scrollbar border-b border-border bg-surface px-4 py-2 text-sm">
            {visibleGroups.flatMap(([, items]) => items).map(({ key, label, href: to, icon: Icon, exact, alsoActive }) => (
              <NavLink key={key} href={to} exact={exact} alsoActive={alsoActive} revealWhenActive>
                <span className="flex items-center gap-2 whitespace-nowrap">
                  {Icon && <Icon className="h-4 w-4 shrink-0" aria-hidden />}
                  {label}
                </span>
              </NavLink>
            ))}
          </nav>
          <ModuleSubNav slug={slug} navs={subNavs} />
          <main className="flex-1 min-w-0 p-4 sm:p-6 md:p-10 bg-main">{children}</main>
        </div>
      </div>
      <PortalGuideAiWidget
        slug={slug}
        restaurantName={t.config.restaurantName}
        planTier={t.config.tier ?? undefined}
        subscriptionStatus={t.config.subscriptionStatus ?? undefined}
      />
    </PortalProvider>
  );
}
