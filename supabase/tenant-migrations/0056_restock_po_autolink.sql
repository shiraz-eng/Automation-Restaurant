-- ============================================================================
-- 0056_restock_po_autolink.sql
--
-- "Purchasing should automatically update when we stock inventory": until
-- now, receiving a PO already pushed stock into inventory_items (the
-- receive_purchase_order[_line]() RPCs), but the reverse direction didn't
-- exist — a manual "+ Restock" on the Inventory page never touched any
-- open purchase order for that item, even when one was clearly what the
-- delivery was for. adjust_stock() now auto-links a restock to a single
-- unambiguous open PO line (status 'sent'/'partial', qty > received_qty)
-- for that inventory item: the matched portion applies the exact same
-- weighted-average costing and PO-status transition as
-- receive_purchase_order_line(), and any leftover past what the PO still
-- owed (or a restock with zero/multiple open-PO matches) falls through to
-- the original plain stock_ledger write, unchanged. Never guesses when
-- more than one open PO could apply.
-- ============================================================================

create or replace function public.adjust_stock(
  p_inventory_item_id uuid, p_delta numeric, p_reason text, p_note text default null
) returns numeric
language plpgsql security definer set search_path = public, app as $$
declare
  v_new numeric; v_cost numeric;
  v_line record; v_open_count int;
  v_factor numeric; v_old_stock numeric; v_old_cost numeric;
  v_outstanding_base numeric; v_take_base numeric; v_take_purchase numeric;
  v_receipt_cost_per_base numeric; v_new_cost numeric; v_remaining_lines int;
  v_remaining_delta numeric := p_delta;
begin
  if not (app.has_perm('stock.adjust') or app.has_perm('inventory.manage')
          or (app.can_write() and app.current_member_role() is not null)) then
    raise exception 'forbidden' using errcode = 'insufficient_privilege';
  end if;

  -- Auto-link a manual restock to purchasing when there's exactly one
  -- unambiguous open PO line for this item ("purchasing should
  -- automatically update when we stock inventory"). Zero or multiple
  -- matches fall through to the plain path below unchanged — never guess
  -- which delivery a restock was for. Same weighted-average costing and
  -- PO-status logic as receive_purchase_order_line(), just entered from
  -- the inventory side instead of the purchasing side.
  if coalesce(nullif(p_reason,''),'adjustment') = 'restock' and p_delta > 0 then
    select count(*) into v_open_count
      from public.purchase_order_lines pol
      join public.purchase_orders po on po.id = pol.purchase_order_id
     where pol.inventory_item_id = p_inventory_item_id
       and pol.qty > pol.received_qty
       and po.status in ('sent', 'partial');

    if v_open_count = 1 then
      select pol.id, pol.purchase_order_id, pol.qty, pol.received_qty, pol.unit_cost_cents, po.po_number
        into v_line
        from public.purchase_order_lines pol
        join public.purchase_orders po on po.id = pol.purchase_order_id
       where pol.inventory_item_id = p_inventory_item_id
         and pol.qty > pol.received_qty
         and po.status in ('sent', 'partial')
       limit 1;

      select purchase_unit_to_base, stock_qty, cost_cents_per_base_unit
        into v_factor, v_old_stock, v_old_cost
        from public.inventory_items where id = p_inventory_item_id;

      v_outstanding_base := (v_line.qty - v_line.received_qty) * coalesce(v_factor, 1);
      v_take_base := least(v_remaining_delta, v_outstanding_base);

      if v_take_base > 0 then
        v_take_purchase := v_take_base / greatest(coalesce(v_factor, 1), 0.0001);
        v_receipt_cost_per_base := v_line.unit_cost_cents / greatest(coalesce(v_factor, 1), 0.0001);
        v_new_cost := case when (coalesce(v_old_stock, 0) + v_take_base) > 0
          then (coalesce(v_old_stock, 0) * coalesce(v_old_cost, 0) + v_take_base * v_receipt_cost_per_base)
               / (coalesce(v_old_stock, 0) + v_take_base)
          else coalesce(v_old_cost, 0) end;

        update public.inventory_items
           set stock_qty = stock_qty + v_take_base, cost_cents_per_base_unit = v_new_cost
         where id = p_inventory_item_id
        returning stock_qty into v_new;

        insert into public.stock_ledger (inventory_item_id, delta_qty, reason, note, unit_cost_cents_base)
        values (p_inventory_item_id, v_take_base, 'restock',
                'Auto-matched to PO #' || v_line.po_number || coalesce(' — ' || p_note, ''),
                v_receipt_cost_per_base);

        update public.purchase_order_lines set received_qty = received_qty + v_take_purchase where id = v_line.id;

        select count(*) into v_remaining_lines from public.purchase_order_lines
         where purchase_order_id = v_line.purchase_order_id and received_qty < qty;
        update public.purchase_orders
           set status = case when v_remaining_lines = 0 then 'received'::app.po_status else 'partial'::app.po_status end,
               received_at = case when v_remaining_lines = 0 then now() else received_at end
         where id = v_line.purchase_order_id;

        v_remaining_delta := v_remaining_delta - v_take_base;
        if v_remaining_delta = 0 then return v_new; end if;
      end if;
    end if;
  end if;

  select cost_cents_per_base_unit into v_cost from public.inventory_items where id = p_inventory_item_id;
  update public.inventory_items set stock_qty = stock_qty + v_remaining_delta
   where id = p_inventory_item_id returning stock_qty into v_new;
  if not found then raise exception 'inventory_item_not_found' using errcode = 'foreign_key_violation'; end if;
  if v_new < 0 then raise exception 'would_go_negative' using errcode = 'check_violation'; end if;
  insert into public.stock_ledger (inventory_item_id, delta_qty, reason, note, unit_cost_cents_base)
  values (p_inventory_item_id, v_remaining_delta, coalesce(nullif(p_reason,''),'adjustment')::app.stock_reason, p_note, v_cost);
  return v_new;
end $$;
revoke all on function public.adjust_stock(uuid, numeric, text, text) from public;
grant execute on function public.adjust_stock(uuid, numeric, text, text) to authenticated, service_role;
