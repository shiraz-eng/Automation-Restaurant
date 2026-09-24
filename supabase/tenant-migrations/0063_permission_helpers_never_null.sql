-- ============================================================================
-- Tenant delta 0063 — permission helpers must never return NULL.
--
-- SECURITY FIX. app.can_write() was
--     select app.current_member_role() in ('owner', 'manager')
-- which is NULL — not false — for any JWT without a member role, i.e. every
-- custom-portal login. Many SECURITY DEFINER functions guard themselves with
--     if not (app.has_perm('x') or app.can_write()) then raise 'forbidden'
-- and for a portal lacking 'x' that is  not (false or NULL)  =  NULL,  which
-- an IF treats as "don't raise": the check was silently skipped. Examples:
-- approve_purchase_order, record_supplier_payment, receive_purchase_order,
-- submit_stock_count, record_ingredient_waste, set_product_priority,
-- set_priority_allocation, supplier_statement.
--
-- Row-level security was NOT affected (a NULL policy result already denies),
-- and guards that don't OR in can_write() were not affected. Owner/manager
-- (true) and every other role (false) behave exactly as before; only the
-- NULL case changes, to false. has_perm() gets the same treatment so a
-- request with no role claim at all can't produce NULL either.
-- ============================================================================

create or replace function app.can_write()
returns boolean language sql stable as $$
  select coalesce(app.current_member_role() in ('owner', 'manager'), false)
$$;

create or replace function app.has_perm(p_perm text)
returns boolean language sql stable as $$
  select coalesce(
    app.jwt_role() = 'service_role'
    or '*' = any(app.jwt_permissions())
    or p_perm = any(app.jwt_permissions())
    -- transitional: an owner/manager with no explicit permissions still writes.
    or (app.jwt_permissions() = '{}'::text[] and app.can_write()),
    false)
$$;
