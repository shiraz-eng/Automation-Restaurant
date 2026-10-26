import {
  Activity, BadgeCheck, BookOpen, Bot, Building2, CalendarCheck, CalendarClock, ChartColumn, ChefHat, ClipboardList, Coins, CreditCard,
  FileDown, HandCoins, Hourglass, KeyRound, Landmark, Languages, LayoutDashboard, LifeBuoy, Megaphone, Package, Palette, Percent, PieChart, QrCode,
  ReceiptText, Scale, ScrollText, Settings, Share2, ShoppingCart, Sparkles, Star, Tag, TriangleAlert, Truck, Undo2, UserRound, Users,
  UtensilsCrossed, Wallet, type LucideIcon,
} from 'lucide-react';
import type { FeatureKey } from '@automation-restaurant/shared';
import { can } from '@/lib/permissions';
import type { ModuleAccent } from '@/components/module/ModuleLanding';

/**
 * The portal's modules: what the sidebar lists (one entry per module) and
 * what each module's landing page offers as tiles. Every tile is an existing
 * screen, carrying the same gates the old per-screen sidebar links had:
 *
 *   perm       permission key ('' = any signed-in staff)
 *   ownerOnly  owner role only (a branch's own manager may also run its portals)
 *   feature    plan feature; staff without it don't see the tile, the owner
 *              sees it (the screen shows the upgrade paywall)
 *   hideInBranch  not shown inside a branch workspace (billed / managed centrally)
 *
 * Hiding a tile is never the security boundary: each screen enforces its own
 * gate (gatePortalPage) and the database its RLS.
 */
export type ModuleToolDef = {
  key: string;
  title: string;
  description: string;
  /** Path under /r/<slug>/ ('' = the dashboard). */
  path: string;
  icon: LucideIcon;
  accent: ModuleAccent;
  perm: string;
  ownerOnly?: boolean;
  feature?: FeatureKey;
  hideInBranch?: boolean;
  /** A shortcut to a screen another module owns: it does not highlight this module in the sidebar. */
  shared?: boolean;
};

export type ModuleKey = 'pos' | 'kitchen' | 'menu' | 'marketing' | 'inventory' | 'suppliers' | 'finance' | 'staff' | 'analytics' | 'ai' | 'settings';

export type ModuleDef = {
  key: ModuleKey;
  label: string;
  /** The landing page's subtitle. */
  subtitle: string;
  icon: LucideIcon;
  accent: ModuleAccent;
  /** Landing path under /r/<slug>/. */
  landing: string;
  tools: ModuleToolDef[];
  /**
   * A custom sub-navigation bar (Finance); other modules' bars list their
   * screens (moduleSubNav). Entries whose screen another module owns are `shared`.
   */
  subnav?: ModuleSubNavDef[];
};

/** One sub-navigation link: the gate fields mean the same as on a tile. */
export type ModuleSubNavDef = Pick<ModuleToolDef, 'key' | 'title' | 'path' | 'perm' | 'ownerOnly' | 'feature' | 'hideInBranch' | 'shared'>;

export const MODULES: ModuleDef[] = [
  {
    key: 'pos',
    label: 'POS & Orders',
    subtitle: 'Take payments, follow every order and run the floor.',
    icon: ShoppingCart,
    accent: 'violet',
    landing: 'modules/pos',
    tools: [
      { key: 'checkout', title: 'Checkout', description: 'Open bills, take payment, print receipts and issue refunds.', path: 'checkout', icon: CreditCard, accent: 'violet', perm: 'payments.view' },
      { key: 'orders', title: 'Orders', description: 'Every order with its items, status and totals.', path: 'orders', icon: ClipboardList, accent: 'blue', perm: 'orders.view' },
      { key: 'live', title: 'Live Ops', description: "Today's orders and guest feedback as they come in.", path: 'live', icon: Activity, accent: 'emerald', perm: 'orders.view' },
      { key: 'tables', title: 'Tables & QR', description: 'Your tables and the QR codes guests order from.', path: 'tables', icon: QrCode, accent: 'teal', perm: 'tables.view' },
      { key: 'exceptions', title: 'Attention', description: 'Issues across the restaurant that need someone to act.', path: 'exceptions', icon: TriangleAlert, accent: 'amber', perm: 'orders.view' },
      { key: 'close', title: 'Day Close', description: 'Count the cash, check the day and lock it.', path: 'close', icon: CalendarCheck, accent: 'indigo', perm: 'finance.view' },
    ],
  },
  {
    key: 'kitchen',
    label: 'Kitchen',
    subtitle: 'Live tickets, ticket history and what the kitchen can still cook.',
    icon: ChefHat,
    accent: 'orange',
    landing: 'modules/kitchen',
    tools: [
      { key: 'kds', title: 'Kitchen Display', description: 'Live tickets by station, food availability, bump when ready.', path: 'kds', icon: ChefHat, accent: 'orange', perm: 'kitchen.view', feature: 'kds.realtime' },
      { key: 'kot', title: 'KOT History', description: 'Every kitchen order ticket sent, with its timings.', path: 'kds/history', icon: ScrollText, accent: 'amber', perm: 'kitchen.view', feature: 'kds.realtime' },
    ],
  },
  {
    key: 'menu',
    label: 'Menu',
    subtitle: 'Dishes, sizes, add-ons and combo deals.',
    icon: UtensilsCrossed,
    accent: 'fuchsia',
    landing: 'modules/menu',
    tools: [
      { key: 'menu', title: 'Menu Items', description: 'Dishes, sizes, add-ons, images and prices.', path: 'menu', icon: UtensilsCrossed, accent: 'fuchsia', perm: 'menu.view' },
      { key: 'deals', title: 'Deals & Combos', description: 'Bundles and combo meals with their own price and schedule.', path: 'deals', icon: Tag, accent: 'violet', perm: 'deals.view' },
    ],
  },
  {
    key: 'marketing',
    label: 'Marketing',
    subtitle: 'Promotions, social media and what guests say about you.',
    icon: Megaphone,
    accent: 'rose',
    landing: 'modules/marketing',
    tools: [
      { key: 'promotions', title: 'Promotions', description: 'Discount codes, automatic offers and how they perform.', path: 'promotions', icon: Megaphone, accent: 'rose', perm: 'menu.view' },
      { key: 'social', title: 'Social Media', description: 'Plan and publish posts about your dishes and offers.', path: 'social', icon: Share2, accent: 'blue', perm: 'social.view' },
      { key: 'reviews', title: 'Reviews', description: 'Ratings and comments guests leave after their meal.', path: 'reviews', icon: Star, accent: 'amber', perm: 'reviews.view', feature: 'staff.management' },
    ],
  },
  {
    key: 'inventory',
    label: 'Inventory',
    subtitle: 'Ingredient stock, recipes, food cost and what is on sale.',
    icon: Package,
    accent: 'emerald',
    landing: 'modules/inventory',
    tools: [
      { key: 'stock', title: 'Stock', description: 'Ingredient levels, restocks, waste, counts and low-stock alerts.', path: 'inventory', icon: Package, accent: 'emerald', perm: 'stock.view', feature: 'inventory.recipe_deduction' },
      { key: 'recipes', title: 'Recipes & Food Cost', description: 'Link dishes to ingredients and see what each one costs.', path: 'recipes', icon: BookOpen, accent: 'teal', perm: 'menu.view', feature: 'inventory.recipe_deduction' },
      { key: 'availability', title: 'Availability History', description: 'When each dish went off and back on sale, and why.', path: 'menu/availability', icon: Hourglass, accent: 'amber', perm: 'availability.view' },
      { key: 'priority', title: 'Priority Allocation', description: 'Which dishes get scarce ingredients first.', path: 'menu/priority', icon: Scale, accent: 'indigo', perm: 'availability.view' },
    ],
  },
  {
    key: 'suppliers',
    label: 'Suppliers',
    subtitle: 'The people you buy from, purchase orders, deliveries and invoices.',
    icon: Truck,
    accent: 'blue',
    landing: 'modules/suppliers',
    tools: [
      { key: 'suppliers', title: 'Suppliers', description: 'Contacts, prices and what each supplier sells you.', path: 'suppliers', icon: Truck, accent: 'blue', perm: 'supplier.view', feature: 'inventory.recipe_deduction' },
      { key: 'purchasing', title: 'Purchasing', description: 'Purchase orders, receiving, invoice matching and payments.', path: 'purchasing', icon: HandCoins, accent: 'indigo', perm: 'purchases.view', feature: 'inventory.recipe_deduction' },
    ],
  },
  {
    key: 'finance',
    label: 'Finance',
    subtitle: "Manage your restaurant's financial operations, expenses and payments.",
    icon: Wallet,
    accent: 'violet',
    landing: 'finance',
    tools: [
      { key: 'overview', title: 'Finance Overview', description: 'Profit, food cost, payables aging and month-by-month results.', path: 'finance/overview', icon: ChartColumn, accent: 'violet', perm: 'finance.view', feature: 'accounting.finance' },
      { key: 'expenses', title: 'Expenses', description: 'Record, approve and pay operating expenses.', path: 'expenses', icon: ReceiptText, accent: 'blue', perm: 'finance.view', feature: 'accounting.finance' },
      { key: 'ledger', title: 'Ledger', description: 'Every money event, traceable to the record behind it.', path: 'finance/ledger', icon: BookOpen, accent: 'emerald', perm: 'finance.view', feature: 'accounting.finance' },
      { key: 'refunds', title: 'Refund Approvals', description: 'Set how large a refund staff can give before it needs sign-off.', path: 'settings/refunds', icon: Undo2, accent: 'orange', perm: 'settings.view', shared: true, ownerOnly: true },
      { key: 'payouts', title: 'Payments & Payouts', description: 'Match supplier invoices, record payouts and see what you owe.', path: 'purchasing', icon: HandCoins, accent: 'indigo', perm: 'purchases.view', shared: true, feature: 'inventory.recipe_deduction' },
      { key: 'tax', title: 'Tax & Compliance', description: 'The sales tax rate charged on every order.', path: 'settings/tax', icon: Landmark, accent: 'amber', perm: 'settings.view', shared: true, ownerOnly: true },
      { key: 'close', title: 'Day Close & Cash', description: 'Cash movements, counted cash and locking the business day.', path: 'close', icon: CalendarCheck, accent: 'teal', perm: 'finance.view', shared: true },
      { key: 'reports', title: 'Reports', description: 'Every PDF report and Excel export, who ran it and for when.', path: 'exports', icon: PieChart, accent: 'fuchsia', perm: 'reports.view', shared: true, feature: 'analytics.advanced' },
      { key: 'settings', title: 'Finance Settings', description: 'The currency used on bills, reports and exports.', path: 'settings/currency', icon: Settings, accent: 'slate', perm: 'settings.view', shared: true, ownerOnly: true },
      { key: 'billing', title: 'Subscription Billing', description: 'Your Automation Restaurant plan and payments.', path: 'billing', icon: CreditCard, accent: 'rose', perm: 'settings.view', shared: true, ownerOnly: true, hideInBranch: true },
    ],
    subnav: [
      { key: 'overview', title: 'Overview', path: 'finance/overview', perm: 'finance.view', feature: 'accounting.finance' },
      { key: 'ledger', title: 'Ledger', path: 'finance/ledger', perm: 'finance.view', feature: 'accounting.finance' },
      { key: 'expenses', title: 'Expenses', path: 'expenses', perm: 'finance.view', feature: 'accounting.finance' },
      { key: 'payables', title: 'Payables & Invoices', path: 'purchasing', perm: 'purchases.view', feature: 'inventory.recipe_deduction', shared: true },
      { key: 'close', title: 'Cash & Day Close', path: 'close', perm: 'finance.view', shared: true },
      { key: 'recipes', title: 'Recipes & Food Cost', path: 'recipes', perm: 'menu.view', feature: 'inventory.recipe_deduction', shared: true },
      { key: 'performance', title: 'Performance', path: '', perm: 'analytics.view', shared: true },
      { key: 'reports', title: 'Report History', path: 'exports', perm: 'reports.view', feature: 'analytics.advanced', shared: true },
      { key: 'audit', title: 'Audit Log', path: 'audit', perm: 'reports.view', shared: true },
    ],
  },
  {
    key: 'staff',
    label: 'Staff',
    subtitle: 'Your team, their shifts and attendance, and station logins.',
    icon: Users,
    accent: 'teal',
    landing: 'modules/staff',
    tools: [
      { key: 'team', title: 'Team', description: 'Staff accounts, roles and what each person can do.', path: 'staff', icon: UserRound, accent: 'teal', perm: 'staff.view', feature: 'staff.management' },
      { key: 'shifts', title: 'Shifts & Attendance', description: 'Plan the rota, clock in and out, attendance insights.', path: 'scheduling', icon: CalendarClock, accent: 'blue', perm: 'attendance.view', feature: 'staff.management' },
      { key: 'portals', title: 'Kiosk Portals', description: 'Station logins with exactly the permissions they need.', path: 'portals', icon: KeyRound, accent: 'violet', perm: 'portals.view', ownerOnly: true, feature: 'portals.advanced' },
    ],
  },
  {
    key: 'analytics',
    label: 'Analytics',
    subtitle: 'Performance, report history and a record of who changed what.',
    icon: ChartColumn,
    accent: 'indigo',
    landing: 'modules/analytics',
    tools: [
      { key: 'performance', title: 'Performance Dashboard', description: 'Sales, trends, best sellers and restaurant performance.', path: '', icon: LayoutDashboard, accent: 'indigo', perm: 'analytics.view' },
      { key: 'exports', title: 'Report & Export History', description: 'Every PDF report and Excel export, who ran it and for when.', path: 'exports', icon: FileDown, accent: 'fuchsia', perm: 'reports.view', feature: 'analytics.advanced' },
      { key: 'audit', title: 'Audit Log', description: 'Who changed what, and when, across the restaurant.', path: 'audit', icon: ScrollText, accent: 'slate', perm: 'reports.view' },
    ],
  },
  {
    key: 'ai',
    label: 'AI Intelligence',
    subtitle: 'Ask the assistant, approve what it proposes, and get guided help.',
    icon: Sparkles,
    accent: 'violet',
    landing: 'modules/ai',
    tools: [
      { key: 'assistant', title: 'Assistant', description: 'Ask about your restaurant, import data and draft actions.', path: 'ai', icon: Bot, accent: 'violet', perm: 'ai.view', feature: 'analytics.advanced' },
      { key: 'approvals', title: 'Approvals', description: 'Actions the assistant proposed that are waiting for you.', path: 'approvals', icon: BadgeCheck, accent: 'emerald', perm: 'ai.approve_sensitive_action' },
      { key: 'guide', title: 'AI Guide', description: 'Step-by-step help with any screen in the app.', path: 'guide', icon: LifeBuoy, accent: 'blue', perm: '' },
      { key: 'ai-settings', title: 'AI & Voice Settings', description: 'Model, languages and voice for each module.', path: 'settings/ai', icon: Languages, accent: 'slate', perm: 'settings.view', shared: true },
    ],
  },
  {
    key: 'settings',
    label: 'Settings',
    subtitle: 'Brand, branches, money rules and your subscription.',
    icon: Settings,
    accent: 'slate',
    landing: 'modules/settings',
    tools: [
      { key: 'brand', title: 'Brand Kit', description: 'Logo, colours, appearance and receipt design.', path: 'settings/theme', icon: Palette, accent: 'fuchsia', perm: 'settings.view', feature: 'menu.branded' },
      { key: 'branches', title: 'Branches', description: 'Your other locations and how they compare.', path: 'branches', icon: Building2, accent: 'blue', perm: 'branches.view', feature: 'branches.multi', hideInBranch: true },
      { key: 'currency', title: 'Currency', description: 'The currency used on bills, reports and exports.', path: 'settings/currency', icon: Coins, accent: 'amber', perm: 'settings.view', ownerOnly: true },
      { key: 'tax', title: 'Tax', description: 'The sales tax rate charged on every order.', path: 'settings/tax', icon: Percent, accent: 'teal', perm: 'settings.view', ownerOnly: true },
      { key: 'refunds', title: 'Refund Approvals', description: 'How large a refund staff can give before it needs sign-off.', path: 'settings/refunds', icon: Undo2, accent: 'orange', perm: 'settings.view', ownerOnly: true },
      { key: 'billing', title: 'Billing', description: 'Your Automation Restaurant plan and payments.', path: 'billing', icon: CreditCard, accent: 'rose', perm: 'settings.view', ownerOnly: true, hideInBranch: true },
      { key: 'ai-settings', title: 'AI & Voice', description: 'Which AI model answers in each module, its languages and voice.', path: 'settings/ai', icon: Languages, accent: 'violet', perm: 'settings.view' },
    ],
  },
];

export function moduleByKey(key: string): ModuleDef | undefined {
  return MODULES.find((m) => m.key === key);
}

export type ToolAccess = {
  role: string;
  perms: string[];
  isEntitled: (f: FeatureKey) => boolean;
  isBranchWorkspace: boolean;
};

/** The sidebar's former canSee(), per tile. */
export function toolVisible(tool: ModuleSubNavDef, a: ToolAccess): boolean {
  // A branch's own manager runs its portals; billing and settings stay with the owner.
  const branchManagerMay = a.isBranchWorkspace && a.role === 'branch_manager' && tool.path === 'portals';
  if (tool.ownerOnly && a.role !== 'owner' && !branchManagerMay) return false;
  if (tool.perm && !can(a.perms, a.role, tool.perm)) return false;
  if (a.role !== 'owner' && tool.feature && !a.isEntitled(tool.feature)) return false;
  if (a.isBranchWorkspace && tool.hideInBranch) return false;
  return true;
}

export function visibleTools(m: ModuleDef, a: ToolAccess): ModuleToolDef[] {
  return m.tools.filter((t) => toolVisible(t, a));
}

/**
 * The paths a module's sidebar entry stays highlighted on: its landing page
 * and its screens (the dashboard '' is its own entry, never a module's).
 * Shortcut tiles (`shared`) highlight the module that owns the screen.
 */
export function moduleActivePaths(m: ModuleDef): string[] {
  return [m.landing, ...m.tools.filter((t) => !t.shared && t.path !== '').map((t) => t.path)];
}

/**
 * Other modules' screens nested under one of this module's paths (Inventory's
 * menu/availability under Menu's menu): the sidebar entry is not active there.
 */
export function moduleNestedForeignPaths(m: ModuleDef): string[] {
  const own = moduleActivePaths(m);
  return MODULES.filter((o) => o.key !== m.key)
    .flatMap(moduleActivePaths)
    .filter((p) => own.some((q) => p.startsWith(`${q}/`)));
}

/**
 * A module's sub-navigation bar: its own `subnav` when it defines one
 * (Finance), otherwise its screens in tile order. The dashboard ('') is never
 * a module's own screen, so it counts as shared.
 */
export function moduleSubNav(m: ModuleDef): ModuleSubNavDef[] {
  if (m.subnav) return m.subnav;
  return m.tools.map(({ key, title, path, perm, ownerOnly, feature, hideInBranch, shared }) => ({
    key, title, path, perm, ownerOnly, feature, hideInBranch, shared: Boolean(shared) || path === '',
  }));
}
