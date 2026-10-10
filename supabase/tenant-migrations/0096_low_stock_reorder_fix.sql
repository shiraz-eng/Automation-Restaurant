-- ============================================================================
-- 0096 — Low-stock reorder emails stopped sending.
--
-- 0082 rewrote pending_low_stock_reorders() to pick each item's supplier
-- "order by si.is_preferred desc, si.created_at asc", but supplier_items has
-- no created_at column. The function raised "column si.created_at does not
-- exist" on every call, the cron sweep logged it and moved on, and no reorder
-- email has been sent since. Order by updated_at (then id, for a stable pick)
-- instead; nothing else in the function changes.
-- ============================================================================

do $mig$
declare
  def text := pg_get_functiondef('public.pending_low_stock_reorders()'::regprocedure);
  old_order constant text := 'order by si.is_preferred desc, si.created_at asc';
  new_order constant text := 'order by si.is_preferred desc, si.updated_at asc, si.id';
begin
  if position(old_order in def) > 0 then
    execute replace(def, old_order, new_order);
  elsif position(new_order in def) = 0 then
    raise exception '0096: unexpected supplier ordering in pending_low_stock_reorders()';
  end if;
end $mig$;
