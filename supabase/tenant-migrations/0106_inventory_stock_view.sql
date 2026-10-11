-- ============================================================================
-- 0106 — Multi-branch: stock as the branch in view sees it.
--
-- inventory_items.stock_qty is the total across every branch (0101). Screens,
-- reports, exports and the AI read public.inventory_stock instead: the same
-- columns, with stock_qty = the stock of the branches in view —
--   * a branch login: its own branch(es), never another branch's stock;
--   * the owner with a branch selected: that branch;
--   * the owner on "All branches" (or a restaurant with one branch): the total.
-- Writes still go to inventory_items (0101 applies them to the branch in use).
-- ============================================================================

do $mig$
declare cols text;
begin
  select string_agg(case when attname = 'stock_qty'
                         then $c$case when app.selected_branch_ids() is null and app.allowed_branch_ids() is null then i.stock_qty
             else coalesce((select sum(bs.stock_qty) from public.branch_stock bs
                             where bs.inventory_item_id = i.id and app.in_scope(bs.branch_id)), 0)::numeric(14,3) end as stock_qty$c$
                         else 'i.' || quote_ident(attname) end, ', ' order by attnum)
    into cols
    from pg_attribute where attrelid = 'public.inventory_items'::regclass and attnum > 0 and not attisdropped;
  execute 'drop view if exists public.inventory_stock';
  -- security_invoker: inventory_items' own row security applies to whoever reads.
  execute 'create view public.inventory_stock with (security_invoker = on) as select ' || cols || ' from public.inventory_items i';
end $mig$;

grant select on public.inventory_stock to authenticated, service_role;
