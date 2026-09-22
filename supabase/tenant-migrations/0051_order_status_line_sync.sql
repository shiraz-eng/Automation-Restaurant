-- ============================================================================
-- Tenant delta 0051 — Keep order_lines.kds_status in sync with orders.status
-- on EVERY write path, not just the kitchen_* RPCs.
--
-- orders.status (whole-ticket) and order_lines.kds_status (per-item prep)
-- are two columns kept in sync manually, not by a shared write path: the
-- five kitchen_* RPCs (0010) update both together, but the Orders page
-- (staff_update policy, orders.update permission) writes orders.status
-- directly and has never touched order_lines.kds_status at all — a
-- second, independently-permissioned way to reach the same field.
-- Routing the Orders page through the kitchen_* RPCs instead would work
-- for staff who hold BOTH orders.update and kitchen.update_status, but
-- silently break it for a custom portal granted only orders.update (a
-- legitimate, real configuration via Portal Management). A trigger fixes
-- every current and future writer at once, permission-neutral, since it
-- only fires after a write that already passed that write's own RLS check.
--
-- Mirrors exactly what kitchen_start_order/kitchen_mark_ready/
-- kitchen_complete_order already do to order_lines for the same
-- transition (0010/0020) — redundant (and harmless) when the RPCs
-- themselves trigger it, since they only ever update orders.status once.
-- ============================================================================

-- NOTE on the deliberately missing 'in_kitchen' branch: place_order()
-- itself finalizes EVERY new order at status='in_kitchen' as its own last
-- step (schema.sql ~line 2229) — 'pending' is a transient value that only
-- ever exists inside that same transaction, never externally observable.
-- A trigger that cascades on a transition TO 'in_kitchen' would therefore
-- fire on every single order's creation, not on a genuine "kitchen started
-- this" action, incorrectly advancing every line from queued straight to
-- preparing before anyone touched it. kitchen_start_order() already
-- handles its own queued->preparing cascade explicitly and correctly; this
-- trigger only needs to cover 'ready'/'served', the two transitions that
-- genuinely happen exactly once, after an order is already visible/active
-- — covering exactly the Orders-page direct-write gap this migration
-- exists to close, without the false-positive on order creation.
create or replace function app.sync_order_lines_status()
returns trigger
language plpgsql
security definer set search_path = public, app
as $$
begin
  if new.status is distinct from old.status then
    if new.status = 'ready' then
      update public.order_lines set kds_status = 'ready'
       where order_id = new.id and kds_status not in ('ready', 'served');
    elsif new.status = 'served' then
      update public.order_lines set kds_status = 'served'
       where order_id = new.id and kds_status <> 'served';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists sync_order_lines_status on public.orders;
create trigger sync_order_lines_status
  after update of status on public.orders
  for each row
  execute function app.sync_order_lines_status();
