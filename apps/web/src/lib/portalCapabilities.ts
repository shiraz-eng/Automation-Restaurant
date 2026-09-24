/**
 * The ONE mapping from a portal's granted permissions to the RMS sections
 * it exposes — extracted from the generated (manager/custom) portal page
 * (app/r/[slug]/portal/[portalKey]/page.tsx), which still owns deciding
 * what to fetch and render per section but now calls this instead of
 * keeping its own copy of the rule. Portal Management's Create/Edit
 * Portal preview calls the exact same function client-side, so the
 * preview and the real generated portal can never disagree about what a
 * given set of permissions unlocks (spec: "the preview must be derived
 * from the same permission/capability mapping ... not a separate fake
 * preview implementation").
 */
export type PortalCapabilities = {
  operations: boolean;
  kitchen: boolean;
  cashier: boolean;
  recipes: boolean;
  inventory: boolean;
  suppliers: boolean;
  purchasing: boolean;
  finance: boolean;
  dayClose: boolean;
  analytics: boolean;
  deals: boolean;
  social: boolean;
  staff: boolean;
  /** SchedulingClient (shift-planning grid + attendance log) — it has no
   *  internal permission gating of its own and unconditionally shows every
   *  staff member's name/email/role once given data, so it must require
   *  staff.view, not just attendance.view. Deliberately NOT the same gate
   *  the main-admin /scheduling page uses (attendance.view alone) — that
   *  page is fine because a logged-in staff member's OTHER permissions
   *  already scope what else they can see; a portal's ENTIRE access is
   *  exactly its permission list, so copying a main-admin page's single
   *  nav-level gate here would leak staff PII to a portal that only
   *  granted "view/mark attendance". */
  scheduling: boolean;
  /** The live roster / clock-in-out board (AttendancePortalBoard) — shows
   *  only name/role/status (no email), the minimum needed to mark someone
   *  present — a deliberately narrower view than Scheduling's, so
   *  attendance.view alone unlocks this but NOT the full Staff section. */
  attendanceKiosk: boolean;
  ai: boolean;
  /** MenuManager + PromotionsManager — menu_items/promotions RLS read key. */
  menu: boolean;
  /** TablesManager (QR codes) + ReservationsClient — both tables' RLS read key. */
  tables: boolean;
  /** ExportHistoryPanel — GET /api/ai/export-history requires reports.view. */
  reportHistory: boolean;
};

export function resolvePortalCapabilities(permissions: string[]): PortalCapabilities {
  const has = (k: string) => permissions.includes('*') || permissions.includes(k);
  const hasAny = (keys: string[]) => keys.some(has);
  return {
    operations: has('orders.view'),
    kitchen: has('kitchen.view'),
    cashier: has('payments.view'),
    recipes: hasAny(['inventory.manage_recipes', 'finance.manage_recipes', 'inventory.view_cost']),
    inventory: has('stock.view'),
    suppliers: has('supplier.view'),
    purchasing: has('purchases.view'),
    finance: hasAny(['finance.view', 'finance.create_expense', 'finance.update_expense', 'finance.delete_expense', 'finance.view_profit']),
    dayClose: has('finance.view'),
    // AnalyticsSection reuses the Dashboard's own PerformancePanel verbatim
    // (sales_by_day/revenue_by_category/payment_mix/feedback_summary), and
    // every one of those RPCs requires orders.view server-side — the
    // Dashboard never has to think about this because Owner/Manager always
    // have it, but a custom portal can hold analytics.view/reports.* WITHOUT
    // orders.view, which crashed the whole section with a raw "forbidden"
    // RPC error instead of rendering anything. orders.view is the real
    // floor; the analytics/reports keys on top of it are what actually
    // signal "wants the aggregate view", not a substitute for it.
    analytics: has('orders.view') && hasAny(['analytics.view', 'analytics.export', 'reports.generate', 'reports.export']),
    deals: has('deals.view'),
    social: has('social.view'),
    staff: has('staff.view'),
    scheduling: has('staff.view') && has('attendance.view'),
    attendanceKiosk: has('attendance.view'),
    ai: has('ai.view'),
    menu: has('menu.view'),
    tables: has('tables.view'),
    reportHistory: has('reports.view'),
  };
}

export type PortalSection = { id: string; label: string };

/** Same section list + inclusion rule the generated portal page renders
 *  from — the sidebar/nav a granted portal actually gets. */
export function portalSections(caps: PortalCapabilities): PortalSection[] {
  return (
    [
      caps.operations && { id: 'operations', label: 'Operations' },
      caps.kitchen && { id: 'kitchen', label: 'Kitchen' },
      caps.cashier && { id: 'cashier', label: 'Cashier' },
      caps.tables && { id: 'tables', label: 'Tables & Reservations' },
      caps.menu && { id: 'menu', label: 'Menu & Promotions' },
      caps.recipes && { id: 'recipes', label: 'Recipes & Food Cost' },
      caps.inventory && { id: 'inventory', label: 'Inventory' },
      (caps.suppliers || caps.purchasing) && { id: 'suppliers', label: 'Suppliers & Purchasing' },
      (caps.finance || caps.dayClose) && { id: 'finance', label: 'Finance' },
      caps.analytics && { id: 'analytics', label: 'Analytics' },
      caps.reportHistory && { id: 'reports', label: 'Report History' },
      (caps.deals || caps.social) && { id: 'marketing', label: 'Marketing & Social' },
      caps.attendanceKiosk && { id: 'attendance', label: 'Attendance' },
      (caps.staff || caps.scheduling) && { id: 'staff', label: 'Staff' },
      caps.ai && { id: 'ai', label: 'Assistant' },
    ] as (PortalSection | false)[]
  ).filter((s): s is PortalSection => !!s);
}

/**
 * Every permission key the generated portal page actually reads inside
 * each section — the section's own gate plus every in-section action gate
 * (the has()/hasAny() calls in app/r/[slug]/portal/[portalKey]/page.tsx).
 * Keep this in step with that page: it's what lets Portal Management's
 * preview say exactly which actions a selection unlocks and which stay
 * locked, instead of just listing section names. A key granted to a
 * portal that appears in none of these lists has no effect on a generated
 * portal at all (see portalActionBreakdown's `unused`).
 */
export const SECTION_PERMISSION_KEYS: Record<string, string[]> = {
  operations: ['orders.view', 'orders.update', 'orders.cancel'],
  kitchen: ['kitchen.view', 'kitchen.update_status'],
  cashier: ['payments.view', 'payments.accept', 'orders.create', 'orders.apply_discount', 'payments.refund', 'payments.void', 'orders.cancel'],
  // Creating/deleting a product also needs menu.update: menu_items' RLS
  // write policy checks that one key for every write.
  menu: ['menu.view', 'menu.update', 'menu.create', 'menu.delete', 'inventory.view_cost'],
  tables: ['tables.view', 'tables.update'],
  reports: ['reports.view'],
  recipes: ['inventory.manage_recipes', 'finance.manage_recipes', 'inventory.view_cost'],
  inventory: ['stock.view', 'stock.update', 'stock.adjust', 'inventory.manage', 'inventory.manage_waste', 'stock.count', 'inventory.view_cost', 'finance.manage_purchases'],
  suppliers: [
    'supplier.view', 'supplier.manage',
    'purchases.view', 'purchases.update', 'purchases.approve', 'purchases.receive', 'inventory.manage_purchases',
    'invoices.create', 'invoices.match',
    'payables.view', 'payables.record_payment', 'payables.manage',
  ],
  finance: ['finance.view', 'finance.create_expense', 'finance.update_expense', 'finance.delete_expense', 'finance.view_profit', 'finance.close_day', 'finance.reopen_day'],
  // The three cost keys unlock PerformancePanel's profit tiles and Top
  // Products (period_profitability/item_profitability accept any of them).
  analytics: ['orders.view', 'analytics.view', 'analytics.export', 'reports.generate', 'reports.export', 'finance.view_profit', 'finance.view_cogs', 'inventory.view_cost'],
  marketing: ['deals.view', 'deals.update', 'social.view', 'social.manage', 'social.propose_post', 'social.approve_post'],
  attendance: ['attendance.view', 'attendance.mark', 'attendance.check_in'],
  staff: ['staff.view', 'staff.create', 'staff.update', 'permissions.assign', 'attendance.view', 'attendance.mark'],
  ai: ['ai.view'],
};

/** Keys that only take effect alongside another key — the portal page gates
 *  them as has(key) && has(dep) because the underlying RLS write policy
 *  checks the dependency, so the preview must not call them "allowed" alone. */
export const PERMISSION_REQUIRES: Record<string, string[]> = {
  'menu.create': ['menu.update'],
  'menu.delete': ['menu.update'],
};

export type SectionBreakdown = PortalSection & { allowed: string[]; restricted: string[] };

/** Per-section allowed/restricted action keys for a permission set, plus
 *  any granted keys that no generated-portal section reads at all. */
export function portalActionBreakdown(permissions: string[]): { sections: SectionBreakdown[]; unused: string[] } {
  const all = permissions.includes('*');
  const granted = new Set(permissions);
  const has = (k: string) => all || (granted.has(k) && (PERMISSION_REQUIRES[k] ?? []).every((d) => granted.has(d)));
  const sections = portalSections(resolvePortalCapabilities(permissions)).map((s) => {
    const keys = SECTION_PERMISSION_KEYS[s.id] ?? [];
    return { ...s, allowed: keys.filter(has), restricted: keys.filter((k) => !has(k)) };
  });
  const read = new Set(Object.values(SECTION_PERMISSION_KEYS).flat());
  const unused = all ? [] : permissions.filter((k) => !read.has(k));
  return { sections, unused };
}
