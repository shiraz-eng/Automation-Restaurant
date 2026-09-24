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
 *
 * Every key in permission_catalog appears in SECTION_PERMISSION_KEYS below
 * — each Create Portal option does something in a generated portal
 * (tenant-migrations/0058 added the server-side half for the ones that
 * previously had no feature or enforcement behind them).
 */
export type PortalCapabilities = {
  operations: boolean;
  kitchen: boolean;
  /** FoodStockPanel — set_food_stock()/record_waste(). */
  kitchenStock: boolean;
  cashier: boolean;
  recipes: boolean;
  /** IngredientCostPanel — set_ingredient_cost() (finance.manage_costs). */
  ingredientCosts: boolean;
  inventory: boolean;
  suppliers: boolean;
  purchasing: boolean;
  finance: boolean;
  dayClose: boolean;
  /** PaymentReconciliationPanel (payments.reconcile). */
  paymentReconcile: boolean;
  /** CashCountPanel (finance.reconcile). */
  cashCount: boolean;
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
  /** AttendanceInsights — dashboard, reports, history, export, corrections, own attendance. */
  attendanceInsights: boolean;
  ai: boolean;
  /** ApprovalsPanel — pending AI actions (ai.approve_sensitive_action). */
  aiApprovals: boolean;
  /** MenuManager + PromotionsManager — menu_items/promotions RLS read key. */
  menu: boolean;
  /** VariantsPanel — variants.* keys. */
  variants: boolean;
  /** AvailabilityHistory + PriorityManager. */
  availability: boolean;
  /** TablesManager (tables + QR codes) — restaurant_tables' RLS read key. */
  tables: boolean;
  /** ExportHistoryPanel — GET /api/ai/export-history requires reports.view. */
  reportHistory: boolean;
  reviews: boolean;
  /** ExceptionsPanel — GET /api/ai/attention accepts notifications.*. */
  notifications: boolean;
  /** BrandKitSection + PoliciesManager. */
  settings: boolean;
  /** PortalsManager — delegated Portal Management. */
  portals: boolean;
};

export const ATTENDANCE_INSIGHT_KEYS = [
  'attendance.view_dashboard',
  'attendance.view_reports',
  'attendance.view_employee_reports',
  'attendance.view_own',
  'attendance.view_history',
  'attendance.export',
  'attendance.request_correction',
  'attendance.correct',
  'attendance.approve_correction',
];

export function resolvePortalCapabilities(permissions: string[]): PortalCapabilities {
  const has = (k: string) => permissions.includes('*') || permissions.includes(k);
  const hasAny = (keys: string[]) => keys.some(has);
  return {
    operations: has('orders.view'),
    kitchen: has('kitchen.view'),
    kitchenStock: hasAny(['kitchen.manage_availability', 'kitchen.record_waste']),
    cashier: has('payments.view'),
    recipes: hasAny(['inventory.manage_recipes', 'finance.manage_recipes', 'inventory.view_cost']),
    ingredientCosts: has('finance.manage_costs'),
    inventory: has('stock.view'),
    suppliers: has('supplier.view'),
    purchasing: has('purchases.view'),
    finance: hasAny(['finance.view', 'finance.create_expense', 'finance.update_expense', 'finance.delete_expense', 'finance.view_profit']),
    dayClose: has('finance.view'),
    paymentReconcile: has('payments.reconcile'),
    cashCount: has('finance.reconcile'),
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
    attendanceInsights: hasAny(ATTENDANCE_INSIGHT_KEYS),
    ai: has('ai.view'),
    aiApprovals: has('ai.approve_sensitive_action'),
    menu: has('menu.view'),
    variants: hasAny(['variants.view', 'variants.create', 'variants.update', 'variants.archive']),
    availability: has('availability.view'),
    tables: has('tables.view'),
    reportHistory: has('reports.view'),
    reviews: has('reviews.view'),
    notifications: hasAny(['notifications.view', 'notifications.manage']),
    settings: has('settings.view'),
    portals: has('portals.view'),
  };
}

export type PortalSection = { id: string; label: string };

/** Same section list + inclusion rule the generated portal page renders
 *  from — the sidebar/nav a granted portal actually gets. */
export function portalSections(caps: PortalCapabilities): PortalSection[] {
  return (
    [
      caps.notifications && { id: 'notifications', label: 'Notifications' },
      caps.operations && { id: 'operations', label: 'Operations' },
      (caps.kitchen || caps.kitchenStock) && { id: 'kitchen', label: 'Kitchen' },
      caps.cashier && { id: 'cashier', label: 'Cashier' },
      caps.tables && { id: 'tables', label: 'Tables & QR codes' },
      (caps.menu || caps.variants) && { id: 'menu', label: 'Menu & Promotions' },
      caps.availability && { id: 'availability', label: 'Availability' },
      (caps.recipes || caps.ingredientCosts) && { id: 'recipes', label: 'Recipes & Food Cost' },
      caps.inventory && { id: 'inventory', label: 'Inventory' },
      (caps.suppliers || caps.purchasing) && { id: 'suppliers', label: 'Suppliers & Purchasing' },
      (caps.finance || caps.dayClose || caps.paymentReconcile || caps.cashCount) && { id: 'finance', label: 'Finance' },
      caps.analytics && { id: 'analytics', label: 'Analytics' },
      caps.reportHistory && { id: 'reports', label: 'Report History' },
      caps.reviews && { id: 'reviews', label: 'Reviews' },
      (caps.deals || caps.social) && { id: 'marketing', label: 'Marketing & Social' },
      (caps.attendanceKiosk || caps.attendanceInsights) && { id: 'attendance', label: 'Attendance' },
      (caps.staff || caps.scheduling) && { id: 'staff', label: 'Staff' },
      caps.portals && { id: 'portals', label: 'Portal Management' },
      caps.settings && { id: 'settings', label: 'Settings' },
      (caps.ai || caps.aiApprovals) && { id: 'ai', label: 'Assistant' },
    ] as (PortalSection | false)[]
  ).filter((s): s is PortalSection => !!s);
}

/**
 * Every permission key the generated portal page actually reads inside
 * each section — the section's own gate plus every in-section action gate
 * (the has()/hasAny() calls in app/r/[slug]/portal/[portalKey]/page.tsx).
 * Keep this in step with that page: it's what lets Portal Management's
 * preview say exactly which actions a selection unlocks and which stay
 * locked, instead of just listing section names.
 */
export const SECTION_PERMISSION_KEYS: Record<string, string[]> = {
  notifications: ['notifications.view', 'notifications.manage'],
  operations: ['orders.view', 'orders.update', 'orders.cancel', 'orders.reopen'],
  kitchen: ['kitchen.view', 'kitchen.update_status', 'kitchen.manage_availability', 'kitchen.record_waste'],
  cashier: [
    'payments.view', 'payments.accept', 'orders.create', 'orders.apply_discount', 'orders.override_price',
    'payments.refund', 'payments.approve_refund', 'payments.void', 'payments.adjust', 'orders.cancel',
    'receipts.view', 'receipts.print',
  ],
  tables: ['tables.view', 'tables.create', 'tables.update'],
  // Creating/deleting a product also needs menu.update: menu_items' RLS
  // write policy checks that one key for every write.
  menu: [
    'menu.view', 'menu.update', 'menu.create', 'menu.delete', 'inventory.view_cost',
    'variants.view', 'variants.create', 'variants.update', 'variants.archive',
  ],
  availability: ['availability.view', 'availability.update'],
  recipes: ['inventory.manage_recipes', 'finance.manage_recipes', 'inventory.view_cost', 'finance.manage_costs'],
  inventory: [
    'stock.view', 'stock.update', 'stock.adjust', 'inventory.manage', 'inventory.manage_waste', 'stock.count',
    'stock.history', 'inventory.view_cost', 'finance.manage_purchases',
  ],
  suppliers: [
    'supplier.view', 'supplier.create', 'supplier.update', 'supplier.manage',
    'purchases.view', 'purchases.create', 'purchases.update', 'purchases.delete', 'purchases.approve', 'purchases.receive',
    'inventory.manage_purchases',
    'invoices.view', 'invoices.create', 'invoices.match',
    'payables.view', 'payables.record_payment', 'payables.manage',
  ],
  finance: [
    'finance.view', 'finance.create_expense', 'finance.update_expense', 'finance.delete_expense', 'finance.view_profit',
    'finance.close_day', 'finance.reopen_day', 'finance.reconcile', 'payments.reconcile',
  ],
  // The three cost keys unlock PerformancePanel's profit tiles and Top
  // Products (period_profitability/item_profitability accept any of them).
  analytics: ['orders.view', 'analytics.view', 'analytics.export', 'reports.generate', 'reports.export', 'finance.view_profit', 'finance.view_cogs', 'inventory.view_cost'],
  reports: ['reports.view'],
  reviews: ['reviews.view', 'reviews.analytics', 'reviews.respond', 'reviews.moderate'],
  marketing: ['deals.view', 'deals.create', 'deals.update', 'deals.archive', 'social.view', 'social.manage', 'social.propose_post', 'social.approve_post'],
  attendance: ['attendance.view', 'attendance.mark', 'attendance.check_in', 'attendance.check_out', ...ATTENDANCE_INSIGHT_KEYS],
  staff: ['staff.view', 'staff.create', 'staff.update', 'staff.delete', 'permissions.assign', 'attendance.view', 'attendance.mark'],
  portals: ['portals.view', 'portals.create', 'portals.update', 'portals.disable', 'portals.credentials'],
  settings: ['settings.view', 'settings.update'],
  ai: ['ai.view', 'ai.execute_read', 'ai.execute_write', 'ai.approve_sensitive_action'],
};

/**
 * Keys that only take effect alongside another key. Each entry is a list
 * of requirements that must ALL hold; one requirement may name
 * alternatives with '|'. The portal page gates these the same way (the
 * underlying RLS policy or RPC checks the dependency, or the control lives
 * in a component that only renders with it), so the preview never calls
 * them "allowed" on their own.
 */
export const PERMISSION_REQUIRES: Record<string, string[]> = {
  'menu.create': ['menu.update'],
  'menu.delete': ['menu.update'],
  'supplier.create': ['supplier.view'],
  'supplier.update': ['supplier.view'],
  'supplier.manage': ['supplier.view'],
  'purchases.create': ['purchases.view'],
  'purchases.delete': ['purchases.view'],
  'invoices.view': ['purchases.view'],
  'payments.approve_refund': ['payments.refund'],
  'attendance.check_in': ['attendance.view'],
  'attendance.check_out': ['attendance.view'],
  'attendance.export': ['attendance.view_reports|attendance.view_employee_reports|attendance.view_history'],
  'reviews.analytics': ['reviews.view'],
  'reviews.respond': ['reviews.view'],
  'reviews.moderate': ['reviews.view'],
  'portals.create': ['portals.view'],
  'portals.update': ['portals.view'],
  'portals.disable': ['portals.view'],
  'portals.credentials': ['portals.view'],
  'settings.update': ['settings.view'],
  'availability.update': ['availability.view'],
  'staff.delete': ['staff.view'],
  'ai.execute_read': ['ai.view'],
  'ai.execute_write': ['ai.view', 'ai.execute_read'],
};

/** has(key) including every PERMISSION_REQUIRES dependency of it — what the
 *  generated portal page uses for in-section action gates. */
export function effectiveHas(permissions: string[]): (k: string) => boolean {
  const all = permissions.includes('*');
  const granted = new Set(permissions);
  return (k: string) =>
    all ||
    (granted.has(k) && (PERMISSION_REQUIRES[k] ?? []).every((req) => req.split('|').some((d) => granted.has(d))));
}

export type SectionBreakdown = PortalSection & { allowed: string[]; restricted: string[] };

/** Per-section allowed/restricted action keys for a permission set, plus
 *  any granted key that ends up doing nothing — its section isn't unlocked,
 *  or a key it depends on isn't selected. */
export function portalActionBreakdown(permissions: string[]): { sections: SectionBreakdown[]; unused: string[] } {
  const all = permissions.includes('*');
  const has = effectiveHas(permissions);
  const sections = portalSections(resolvePortalCapabilities(permissions)).map((s) => {
    const keys = SECTION_PERMISSION_KEYS[s.id] ?? [];
    return { ...s, allowed: keys.filter(has), restricted: keys.filter((k) => !has(k)) };
  });
  const effective = new Set(sections.flatMap((s) => s.allowed));
  const unused = all ? [] : permissions.filter((k) => !effective.has(k));
  return { sections, unused };
}
