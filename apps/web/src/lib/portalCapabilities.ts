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
    analytics: hasAny(['analytics.view', 'analytics.export', 'reports.generate', 'reports.export']),
    deals: has('deals.view'),
    social: has('social.view'),
    staff: has('staff.view'),
    scheduling: has('staff.view') && has('attendance.view'),
    attendanceKiosk: has('attendance.view'),
    ai: has('ai.view'),
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
      caps.recipes && { id: 'recipes', label: 'Recipes & Food Cost' },
      caps.inventory && { id: 'inventory', label: 'Inventory' },
      (caps.suppliers || caps.purchasing) && { id: 'suppliers', label: 'Suppliers & Purchasing' },
      (caps.finance || caps.dayClose) && { id: 'finance', label: 'Finance' },
      caps.analytics && { id: 'analytics', label: 'Analytics' },
      (caps.deals || caps.social) && { id: 'marketing', label: 'Marketing & Social' },
      caps.attendanceKiosk && { id: 'attendance', label: 'Attendance' },
      (caps.staff || caps.scheduling) && { id: 'staff', label: 'Staff' },
      caps.ai && { id: 'ai', label: 'Assistant' },
    ] as (PortalSection | false)[]
  ).filter((s): s is PortalSection => !!s);
}
