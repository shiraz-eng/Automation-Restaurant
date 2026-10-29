-- ============================================================================
-- 0111 — Kiosk portals: idle sign-out, and waste entry from a kitchen station.
--
-- portals.idle_minutes: a station login (shared counter / kitchen tablet) is
-- signed out after this many minutes without a touch or key press. NULL = never
-- (the behaviour so far). Set in Portal Management; enforced by the kiosk page.
--
-- waste_item_options(): the ingredient list for the waste entry form. A kitchen
-- station that may record waste (kitchen.record_waste) usually has no stock.view,
-- so it can't read inventory_items itself; this returns only what the form needs
-- (name, unit, purchase unit, this branch's stock) to anyone app.can_record_waste()
-- allows (tenant-migrations/0109), and nothing to anyone else.
-- ============================================================================

alter table public.portals add column if not exists idle_minutes int
  check (idle_minutes is null or idle_minutes between 1 and 720);

create or replace function public.waste_item_options()
returns table (id uuid, name text, unit text, stock_qty numeric, min_threshold numeric,
               purchase_unit_label text, purchase_unit_to_base numeric)
language sql stable security definer set search_path = public, app as $fn$
  select i.id, i.name, i.unit, i.stock_qty, i.min_threshold, i.purchase_unit_label, i.purchase_unit_to_base
    from app.inv i
   where app.can_record_waste()
   order by i.name
$fn$;
revoke all on function public.waste_item_options() from public;
grant execute on function public.waste_item_options() to authenticated, service_role;
