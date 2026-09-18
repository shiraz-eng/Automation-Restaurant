// Portal-level permission bundles, used by Portal Management / Kiosk
// Portals (apps/web/.../portals/PortalsManager.tsx) — a shorthand over
// the SAME permission_catalog keys the granular checkboxes already
// offer; no separate authorization concept. Owner-only sections (Kiosk
// Portals, Billing, Policies) are deliberately absent — those stay
// owner-only regardless of what's toggled here. There is no in-app
// Roles & Access Control screen (removed by request) — role/portal
// permissions are set at creation time and, for portals, edited by
// deleting and recreating; the underlying permission system, RLS, and
// the protect_owner_only_permissions trigger on public.roles are
// unaffected by that screen's absence.
export const PORTAL_BUNDLES: { portal: string; keys: string[] }[] = [
  { portal: 'Operations', keys: ['orders.view', 'orders.create', 'orders.update', 'orders.cancel', 'orders.reopen', 'orders.apply_discount', 'orders.override_price', 'tables.view', 'tables.create', 'tables.update', 'availability.view', 'availability.update'] },
  { portal: 'Kitchen', keys: ['kitchen.view', 'kitchen.update_status', 'kitchen.manage_availability', 'kitchen.record_waste'] },
  { portal: 'Cashier', keys: ['payments.view', 'payments.accept', 'receipts.view', 'receipts.print'] },
  { portal: 'Recipes & Food Cost', keys: ['inventory.manage_recipes', 'finance.manage_recipes', 'inventory.view_cost'] },
  { portal: 'Inventory', keys: ['stock.view', 'stock.update', 'stock.adjust', 'stock.history', 'stock.count', 'inventory.manage_waste'] },
  { portal: 'Suppliers & Purchasing', keys: ['supplier.view', 'supplier.create', 'supplier.update', 'supplier.manage', 'purchases.view', 'purchases.create', 'purchases.update', 'purchases.delete', 'purchases.receive', 'purchases.approve', 'invoices.view', 'invoices.create', 'invoices.match', 'payables.view', 'payables.record_payment', 'payables.manage'] },
  { portal: 'Finance', keys: ['finance.view', 'finance.create_expense', 'finance.update_expense', 'finance.delete_expense', 'finance.view_cogs', 'finance.view_profit', 'finance.manage_costs', 'finance.reconcile', 'finance.close_day', 'finance.reopen_day', 'payments.refund', 'payments.approve_refund', 'payments.void', 'payments.adjust'] },
  { portal: 'Analytics', keys: ['analytics.view', 'analytics.export', 'reports.generate', 'reports.export'] },
  { portal: 'Marketing & Social', keys: ['deals.view', 'deals.create', 'deals.update', 'deals.archive', 'social.view', 'social.manage', 'social.propose_post', 'social.approve_post'] },
  { portal: 'Staff', keys: ['staff.view', 'staff.create', 'staff.update', 'staff.disable', 'attendance.view', 'attendance.mark', 'attendance.view_dashboard', 'attendance.view_reports', 'attendance.correct', 'attendance.approve_correction'] },
  { portal: 'AI Assistant', keys: ['ai.view', 'ai.execute_read', 'ai.execute_write', 'ai.approve_sensitive_action'] },
];
