-- ============================================================================
-- 0057_permission_catalog_metadata.sql
--
-- Adds real metadata (type, risk_level) to permission_catalog so Portal
-- Management's Create/Edit Portal screen can show an actual Read/Write/
-- Approval/Export/High-risk breakdown of a selection, instead of guessing
-- from key-name suffixes client-side. Also adds two permission keys
-- (inventory.manage, inventory.manage_purchases) that are already checked
-- server-side (adjust_stock's has_perm(), the Inventory portal section's
-- gate in portal/[portalKey]/page.tsx) but were never in the catalog table
-- at all — meaning a portal could never actually be granted them through
-- the Create Portal checkbox list. That's a functional dead end, not a
-- cosmetic gap.
-- ============================================================================

alter table public.permission_catalog
  add column if not exists type text not null default 'write' check (type in ('read', 'write', 'approval', 'export')),
  add column if not exists risk_level text not null default 'normal' check (risk_level in ('normal', 'high'));

do $$
declare r record;
begin
  for r in select * from (values
    -- key, type, risk_level
    ('orders.view', 'read', 'normal'),
    ('orders.create', 'write', 'normal'),
    ('orders.update', 'write', 'normal'),
    ('orders.cancel', 'write', 'normal'),
    ('orders.reopen', 'write', 'normal'),
    ('orders.apply_discount', 'write', 'normal'),
    ('orders.override_price', 'write', 'high'),
    ('payments.view', 'read', 'normal'),
    ('payments.accept', 'write', 'normal'),
    ('payments.refund', 'write', 'normal'),
    ('payments.approve_refund', 'approval', 'high'),
    ('payments.void', 'write', 'high'),
    ('payments.adjust', 'write', 'high'),
    ('payments.reconcile', 'write', 'normal'),
    ('receipts.view', 'read', 'normal'),
    ('receipts.print', 'export', 'normal'),
    ('kitchen.view', 'read', 'normal'),
    ('kitchen.update_status', 'write', 'normal'),
    ('kitchen.manage_availability', 'write', 'normal'),
    ('kitchen.record_waste', 'write', 'normal'),
    ('menu.view', 'read', 'normal'),
    ('menu.create', 'write', 'normal'),
    ('menu.update', 'write', 'normal'),
    ('menu.delete', 'write', 'high'),
    ('variants.view', 'read', 'normal'),
    ('variants.create', 'write', 'normal'),
    ('variants.update', 'write', 'normal'),
    ('variants.archive', 'write', 'normal'),
    ('stock.view', 'read', 'normal'),
    ('stock.update', 'write', 'normal'),
    ('stock.adjust', 'write', 'normal'),
    ('stock.history', 'read', 'normal'),
    ('stock.count', 'write', 'normal'),
    ('attendance.view', 'read', 'normal'),
    ('attendance.mark', 'write', 'normal'),
    ('attendance.view_dashboard', 'read', 'normal'),
    ('attendance.view_reports', 'read', 'normal'),
    ('attendance.view_employee_reports', 'read', 'normal'),
    ('attendance.view_own', 'read', 'normal'),
    ('attendance.check_in', 'write', 'normal'),
    ('attendance.check_out', 'write', 'normal'),
    ('attendance.view_history', 'read', 'normal'),
    ('attendance.request_correction', 'write', 'normal'),
    ('attendance.correct', 'write', 'normal'),
    ('attendance.approve_correction', 'approval', 'normal'),
    ('attendance.export', 'export', 'normal'),
    ('staff.view', 'read', 'normal'),
    ('staff.create', 'write', 'normal'),
    ('staff.update', 'write', 'normal'),
    ('staff.delete', 'write', 'high'),
    ('reviews.view', 'read', 'normal'),
    ('reviews.analytics', 'read', 'normal'),
    ('reviews.respond', 'write', 'normal'),
    ('reviews.moderate', 'write', 'normal'),
    ('reports.view', 'read', 'normal'),
    ('reports.generate', 'write', 'normal'),
    ('reports.export', 'export', 'normal'),
    ('settings.view', 'read', 'normal'),
    ('settings.update', 'write', 'high'),
    ('portals.view', 'read', 'high'),
    ('portals.create', 'write', 'high'),
    ('portals.update', 'write', 'high'),
    ('portals.disable', 'write', 'high'),
    ('portals.credentials', 'approval', 'high'),
    ('deals.view', 'read', 'normal'),
    ('deals.create', 'write', 'normal'),
    ('deals.update', 'write', 'normal'),
    ('deals.archive', 'write', 'normal'),
    ('customers.view', 'read', 'normal'),
    ('customers.create', 'write', 'normal'),
    ('customers.update', 'write', 'normal'),
    ('tables.view', 'read', 'normal'),
    ('tables.create', 'write', 'normal'),
    ('tables.update', 'write', 'normal'),
    ('availability.view', 'read', 'normal'),
    ('availability.update', 'write', 'normal'),
    ('roles.view', 'read', 'high'),
    ('roles.create', 'write', 'high'),
    ('roles.update', 'write', 'high'),
    ('roles.delete', 'write', 'high'),
    ('permissions.view', 'read', 'high'),
    ('permissions.assign', 'approval', 'high'),
    ('purchases.view', 'read', 'normal'),
    ('purchases.create', 'write', 'normal'),
    ('purchases.update', 'write', 'normal'),
    ('purchases.delete', 'write', 'high'),
    ('purchases.receive', 'write', 'normal'),
    ('purchases.approve', 'approval', 'high'),
    ('supplier.view', 'read', 'normal'),
    ('supplier.create', 'write', 'normal'),
    ('supplier.update', 'write', 'normal'),
    ('supplier.manage', 'write', 'normal'),
    ('invoices.view', 'read', 'normal'),
    ('invoices.create', 'write', 'normal'),
    ('invoices.match', 'approval', 'normal'),
    ('payables.view', 'read', 'normal'),
    ('payables.record_payment', 'write', 'high'),
    ('payables.manage', 'write', 'high'),
    ('inventory.manage_waste', 'write', 'normal'),
    ('inventory.manage_recipes', 'write', 'normal'),
    ('inventory.view_cost', 'read', 'normal'),
    ('finance.view', 'read', 'normal'),
    ('finance.create_expense', 'write', 'normal'),
    ('finance.update_expense', 'write', 'normal'),
    ('finance.delete_expense', 'write', 'high'),
    ('finance.view_cogs', 'read', 'normal'),
    ('finance.view_profit', 'read', 'normal'),
    ('finance.manage_costs', 'write', 'normal'),
    ('finance.manage_recipes', 'write', 'normal'),
    ('finance.manage_purchases', 'write', 'normal'),
    ('finance.reconcile', 'write', 'normal'),
    ('finance.close_day', 'write', 'normal'),
    ('finance.reopen_day', 'write', 'high'),
    ('analytics.view', 'read', 'normal'),
    ('analytics.export', 'export', 'normal'),
    ('notifications.view', 'read', 'normal'),
    ('notifications.manage', 'write', 'normal'),
    ('ai.view', 'read', 'normal'),
    ('ai.execute_read', 'read', 'normal'),
    ('ai.execute_write', 'write', 'high'),
    ('ai.approve_sensitive_action', 'approval', 'high'),
    ('social.view', 'read', 'normal'),
    ('social.manage', 'write', 'normal'),
    ('social.propose_post', 'write', 'normal'),
    ('social.approve_post', 'approval', 'normal')
  ) as t(key, ptype, risk) loop
    update public.permission_catalog set type = r.ptype, risk_level = r.risk where key = r.key;
  end loop;
end $$;

insert into public.permission_catalog (key, grp, label, type, risk_level) values
  ('inventory.manage', 'Inventory', 'Manage inventory items', 'write', 'normal'),
  ('inventory.manage_purchases', 'Inventory', 'Manage purchase automation', 'write', 'normal')
on conflict (key) do update set grp = excluded.grp, label = excluded.label, type = excluded.type, risk_level = excluded.risk_level;
