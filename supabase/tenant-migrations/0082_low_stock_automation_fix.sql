-- ============================================================================
-- 0082_low_stock_automation_fix.sql
-- Fix low-stock reorder automation:
-- 1. Fire sync_low_stock_event trigger on INSERT as well as UPDATE
-- 2. Backfill open low_stock_events for items currently low
-- 3. Update pending_low_stock_reorders() so items without explicit target_stock_qty
--    fall back to a sensible suggested reorder quantity (e.g. 2x threshold)
--    and pick the active/preferred supplier with a valid email address.
-- ============================================================================

create or replace function app.sync_low_stock_event() returns trigger
language plpgsql set search_path = public, app as $fn$
declare v_open_id uuid;
begin
  select id into v_open_id from public.low_stock_events
   where inventory_item_id = new.id and status = 'open';
  if new.stock_qty <= new.min_threshold then
    if v_open_id is null then
      insert into public.low_stock_events (inventory_item_id, stock_at_open, threshold_at_open)
      values (new.id, new.stock_qty, new.min_threshold);
    end if;
  elsif v_open_id is not null then
    update public.low_stock_events set status = 'resolved', resolved_at = now() where id = v_open_id;
  end if;
  return new;
end $fn$;

drop trigger if exists sync_low_stock_event on public.inventory_items;
create trigger sync_low_stock_event after insert or update of stock_qty, min_threshold on public.inventory_items
  for each row execute function app.sync_low_stock_event();

-- Backfill open events for items currently at or below their reorder threshold
insert into public.low_stock_events (inventory_item_id, stock_at_open, threshold_at_open)
select ii.id, ii.stock_qty, ii.min_threshold
from public.inventory_items ii
where ii.stock_qty <= ii.min_threshold
  and not exists (
    select 1 from public.low_stock_events lse
    where lse.inventory_item_id = ii.id and lse.status = 'open'
  );

create or replace function public.pending_low_stock_reorders()
returns table (
  low_stock_event_id uuid, inventory_item_id uuid, item_name text, unit text,
  stock_qty numeric, min_threshold numeric, target_stock_qty numeric, suggested_qty numeric,
  supplier_id uuid, supplier_name text, supplier_email text
)
language plpgsql stable security definer set search_path = public, app as $fn$
begin
  if not (app.has_perm('supplier.view') or app.can_write()) then
    raise exception 'forbidden' using errcode = 'insufficient_privilege';
  end if;
  return query
    select lse.id, ii.id, ii.name, ii.unit,
           ii.stock_qty, ii.min_threshold, ii.target_stock_qty,
           greatest(1, coalesce(ii.target_stock_qty, greatest(ceil(ii.min_threshold * 2), ceil(ii.min_threshold + 5))) - ii.stock_qty),
           sup.supplier_id, sup.supplier_name, sup.supplier_email
      from public.low_stock_events lse
      join public.inventory_items ii on ii.id = lse.inventory_item_id
      cross join lateral (
        select si.supplier_id, s.name as supplier_name, s.email as supplier_email
          from public.supplier_items si
          join public.suppliers s on s.id = si.supplier_id and s.is_active
         where si.inventory_item_id = ii.id and si.is_active
         order by si.is_preferred desc, si.created_at asc
         limit 1
      ) sup
      cross join public.purchasing_settings ps
     where lse.status = 'open'
       and coalesce(ii.auto_reorder_email, true)
       and ps.low_stock_email_enabled
       and sup.supplier_email is not null and sup.supplier_email <> ''
       and not exists (
         select 1 from public.supplier_communications sc
          where sc.low_stock_event_id = lse.id and sc.status = 'sent'
       );
end $fn$;
revoke all on function public.pending_low_stock_reorders() from public;
grant execute on function public.pending_low_stock_reorders() to authenticated, service_role;
