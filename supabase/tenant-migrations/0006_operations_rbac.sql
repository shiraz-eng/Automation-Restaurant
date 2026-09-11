-- ============================================================================
-- Tenant delta 0006 — P3: Operations Portal RBAC enforcement
--
-- Moves operational-table RLS from app.is_staff() / app.can_write() onto the
-- permission primitive app.has_perm(), WITHOUT changing anything that works
-- today. Every policy becomes:  (new has_perm check)  OR  (exact old condition).
--
--   * A JWT with NO explicit app_metadata.permissions array  -> the OR falls
--     through to the legacy is_staff()/can_write() check: identical behaviour.
--   * A JWT WITH an explicit permissions array (portal users now; back-filled
--     staff later) -> gated strictly to its keys ('*' = all).
--
-- Also expands public.permission_catalog to the full Operations / Attendance /
-- AI key set. Idempotent: drop policy if exists + on conflict do update.
-- ============================================================================

-- ── 1. Permission catalog: add the keys the portal specs reference ──────────
insert into public.permission_catalog (key, grp, label) values
  ('orders.reopen','Orders','Reopen orders'),
  ('orders.apply_discount','Orders','Apply discount'),
  ('orders.override_price','Orders','Override item price'),
  ('payments.void','Payments','Void payment'),
  ('payments.adjust','Payments','Adjust payment'),
  ('payments.reconcile','Payments','Reconcile payments'),
  ('receipts.view','Payments','View receipts'),
  ('receipts.print','Payments','Print receipts'),
  ('variants.view','Menu','View variants'),
  ('variants.create','Menu','Create variants'),
  ('variants.update','Menu','Update variants'),
  ('variants.archive','Menu','Archive variants'),
  ('deals.view','Deals','View deals'),
  ('deals.create','Deals','Create deals'),
  ('deals.update','Deals','Update deals'),
  ('deals.archive','Deals','Archive deals'),
  ('customers.view','Customers','View customers'),
  ('customers.create','Customers','Create customers'),
  ('customers.update','Customers','Update customers'),
  ('tables.view','Tables','View tables'),
  ('tables.create','Tables','Create tables'),
  ('tables.update','Tables','Update tables'),
  ('availability.view','Availability','View food availability'),
  ('availability.update','Availability','Update food availability'),
  ('roles.view','Roles','View roles'),
  ('roles.create','Roles','Create roles'),
  ('roles.update','Roles','Update roles'),
  ('roles.delete','Roles','Delete roles'),
  ('permissions.view','Permissions','View permission assignments'),
  ('permissions.assign','Permissions','Assign permissions'),
  ('purchases.view','Purchases','View purchases'),
  ('purchases.create','Purchases','Create purchases'),
  ('purchases.update','Purchases','Update purchases'),
  ('purchases.delete','Purchases','Delete purchases'),
  ('supplier.view','Suppliers','View suppliers'),
  ('supplier.create','Suppliers','Create suppliers'),
  ('supplier.update','Suppliers','Update suppliers'),
  ('supplier.manage','Suppliers','Manage suppliers'),
  ('stock.adjust','Stock','Adjust stock'),
  ('stock.history','Stock','View stock history'),
  ('finance.view','Finance','View finance'),
  ('finance.create_expense','Finance','Create expense'),
  ('finance.update_expense','Finance','Update expense'),
  ('finance.delete_expense','Finance','Delete expense'),
  ('finance.view_cogs','Finance','View COGS'),
  ('finance.view_profit','Finance','View profit'),
  ('finance.manage_costs','Finance','Manage product costs'),
  ('finance.manage_recipes','Finance','Manage recipes'),
  ('finance.manage_purchases','Finance','Manage purchase costs'),
  ('finance.reconcile','Finance','Reconcile cash'),
  ('finance.close_day','Finance','Close business day'),
  ('finance.reopen_day','Finance','Reopen business day'),
  ('reports.generate','Reports','Generate reports'),
  ('reports.export','Reports','Export reports'),
  ('analytics.view','Analytics','View analytics'),
  ('analytics.export','Analytics','Export analytics'),
  ('attendance.view_dashboard','Attendance','View attendance dashboard'),
  ('attendance.view_reports','Attendance','View attendance reports'),
  ('attendance.view_employee_reports','Attendance','View employee attendance reports'),
  ('attendance.view_own','Attendance','View own attendance'),
  ('attendance.check_in','Attendance','Check in'),
  ('attendance.check_out','Attendance','Check out'),
  ('attendance.view_history','Attendance','View attendance history'),
  ('attendance.request_correction','Attendance','Request attendance correction'),
  ('attendance.correct','Attendance','Correct attendance'),
  ('attendance.approve_correction','Attendance','Approve attendance correction'),
  ('attendance.export','Attendance','Export attendance'),
  ('kitchen.manage_availability','Kitchen','Manage food availability'),
  ('kitchen.record_waste','Kitchen','Record kitchen waste'),
  ('notifications.view','Notifications','View notifications'),
  ('notifications.manage','Notifications','Manage notifications'),
  ('ai.view','AI','Use the AI assistant'),
  ('ai.execute_read','AI','AI read actions'),
  ('ai.execute_write','AI','AI write actions'),
  ('ai.approve_sensitive_action','AI','Approve sensitive AI actions')
on conflict (key) do update set grp = excluded.grp, label = excluded.label;

-- ── 2. RLS: permission-gate the operational tables (additive OR) ────────────
do $$
declare r record;
begin
  for r in
    select * from (values
      ('memberships',          'staff.view',     'staff.update',    'mgr_write'),
      ('menu_categories',      'menu.view',      'menu.update',     'mgr_write'),
      ('menu_items',           'menu.view',      'menu.update',     'mgr_write'),
      ('menu_variants',        'menu.view',      'menu.update',     'mgr_write'),
      ('inventory_items',      'stock.view',     'stock.update',    'mgr_write'),
      ('recipe_components',    'menu.view',      'menu.update',     'mgr_write'),
      ('reservations',         'tables.view',    'tables.update',   'mgr_write'),
      ('restaurant_tables',    'tables.view',    'tables.update',   'mgr_write'),
      ('promotions',           'menu.view',      'menu.update',     'mgr_write'),
      ('suppliers',            'supplier.view',  'supplier.manage', 'mgr_write'),
      ('purchase_orders',      'purchases.view', 'purchases.update','mgr_write'),
      ('purchase_order_lines', 'purchases.view', 'purchases.update','mgr_write'),
      ('shifts',               'attendance.view','attendance.mark', 'mgr_write'),
      ('attendance',           'attendance.view','attendance.mark', 'mgr_write'),
      ('orders',               'orders.view',    'orders.update',   'staff_update'),
      ('order_lines',          'orders.view',    'orders.update',   'staff_update'),
      ('stock_ledger',         'stock.view',     null,              null),
      ('table_sessions',       'orders.view',    null,              null),
      ('feedback',             'reviews.view',   null,              null)
    ) as t(tbl, rk, wk, wpol)
  loop
    execute format('alter table public.%I enable row level security;', r.tbl);

    execute format('drop policy if exists staff_read on public.%I;', r.tbl);
    execute format(
      'create policy staff_read on public.%I for select using (app.has_perm(%L) or app.is_staff());',
      r.tbl, r.rk);

    if r.wpol = 'mgr_write' then
      execute format('drop policy if exists mgr_write on public.%I;', r.tbl);
      execute format(
        'create policy mgr_write on public.%I for all using (app.has_perm(%L) or app.can_write()) with check (app.has_perm(%L) or app.can_write());',
        r.tbl, r.wk, r.wk);
    elsif r.wpol = 'staff_update' then
      execute format('drop policy if exists staff_update on public.%I;', r.tbl);
      execute format(
        'create policy staff_update on public.%I for update using (app.has_perm(%L) or app.is_staff()) with check (app.has_perm(%L) or app.is_staff());',
        r.tbl, r.wk, r.wk);
    end if;
  end loop;
end $$;

-- guest_read / guest_insert policies (storefront menu, order tracking, feedback
-- submit) are intentionally left untouched.
