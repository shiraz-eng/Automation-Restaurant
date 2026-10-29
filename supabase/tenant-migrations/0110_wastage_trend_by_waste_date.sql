-- ============================================================================
-- 0110 — Wastage trend by the day the waste happened.
--
-- wastage_report()'s daily series placed every waste movement on the day it
-- was recorded, so a week of waste entered at once showed as one bar. It now
-- uses the entry's own date (waste_entries.occurred_on) when that falls in
-- the period, else the day it was recorded, so the series still adds up to
-- the period total. Totals, stock and Finance are unchanged.
-- ============================================================================

create or replace function public.wastage_report(p_from date, p_to date, p_branch uuid default null) returns jsonb
language plpgsql stable security definer set search_path = public, app as $fn$
declare
  v_tz text; v_min int; v_from timestamptz; v_to timestamptz; v_cost_ok boolean; v_out jsonb;
begin
  if not app.can_view_waste() then raise exception 'forbidden' using errcode = 'insufficient_privilege'; end if;
  if p_from is null or p_to is null or p_from > p_to or p_to - p_from > 400 then raise exception 'bad_range' using errcode = 'check_violation'; end if;
  if p_branch is not null and not app.branch_access(p_branch) then raise exception 'forbidden' using errcode = 'insufficient_privilege'; end if;
  v_cost_ok := coalesce(app.has_perm('inventory.view_cost') or app.can_write(), false);

  select coalesce(timezone, 'UTC'), coalesce(business_day_start_minutes, 0) into v_tz, v_min from public.business_settings where id;
  v_tz := coalesce(v_tz, 'UTC'); v_min := coalesce(v_min, 0);
  v_from := (p_from::timestamp + make_interval(mins => v_min)) at time zone v_tz;
  v_to   := ((p_to + 1)::timestamp + make_interval(mins => v_min)) at time zone v_tz;

  with led as (
    select l.*, coalesce(l.unit_cost_cents_base, i.cost_cents_per_base_unit, 0) as cost, l.unit_cost_cents_base is null as estimated
      from public.stock_ledger l join public.inventory_items i on i.id = l.inventory_item_id
     where l.created_at >= v_from
       and (case when p_branch is null then app.in_scope(l.branch_id) else l.branch_id = p_branch end)
  ),
  cur as (
    select bs.inventory_item_id, sum(bs.stock_qty) as qty from public.branch_stock bs
     where case when p_branch is null then app.in_scope(bs.branch_id) else bs.branch_id = p_branch end
     group by 1
  ),
  per as (
    select inventory_item_id,
      coalesce(sum(delta_qty) filter (where created_at >= v_to), 0) as after_qty,
      coalesce(sum(delta_qty) filter (where created_at < v_to), 0) as period_net,
      coalesce(sum(delta_qty) filter (where created_at < v_to and reason = 'restock'), 0) as receipts,
      coalesce(sum(delta_qty) filter (where created_at < v_to and reason = 'adjustment' and delta_qty > 0), 0) as adj_in,
      coalesce(-sum(delta_qty) filter (where created_at < v_to and reason = 'adjustment' and delta_qty < 0), 0) as adj_out,
      coalesce(-sum(delta_qty) filter (where created_at < v_to and reason = 'order_deduction'), 0) as usage,
      coalesce(-sum(delta_qty * cost) filter (where created_at < v_to and reason = 'order_deduction'), 0) as usage_value,
      coalesce(-sum(delta_qty) filter (where created_at < v_to and reason = 'spoilage'), 0) as waste,
      coalesce(-sum(delta_qty * cost) filter (where created_at < v_to and reason = 'spoilage'), 0) as waste_value,
      coalesce(sum(delta_qty) filter (where created_at < v_to and reason = 'stock_take'), 0) as stock_take,
      count(*) filter (where created_at < v_to and reason in ('spoilage', 'order_deduction') and estimated) as estimated_rows,
      count(*) filter (where created_at < v_to) as period_rows
      from led group by 1
  ),
  consumed as (   -- waste of food an order already used (no stock movement of its own)
    select e.inventory_item_id, sum(e.qty_base) as qty, sum(e.cost_cents) as value
      from public.waste_entries e
     where e.already_consumed and e.status = 'approved' and e.decided_at >= v_from and e.decided_at < v_to
       and (case when p_branch is null then app.in_scope(e.branch_id) else e.branch_id = p_branch end)
     group by 1
  ),
  items as (
    select i.id, i.name, i.unit,
           coalesce(c.qty, 0) - coalesce(p.after_qty, 0) as closing,
           coalesce(p.period_net, 0) as period_net, p.receipts, p.adj_in, p.adj_out, p.usage, p.usage_value,
           p.waste, p.waste_value, p.stock_take, p.estimated_rows,
           coalesce(k.qty, 0) as waste_after_use, coalesce(k.value, 0) as waste_after_use_value,
           i.cost_cents_per_base_unit as unit_cost
      from public.inventory_items i
      left join per p on p.inventory_item_id = i.id
      left join cur c on c.inventory_item_id = i.id
      left join consumed k on k.inventory_item_id = i.id
     where coalesce(p.period_rows, 0) > 0 or k.inventory_item_id is not null
  ),
  wrows as (      -- every waste movement of the period, with its entry's reason
    select l.inventory_item_id, l.delta_qty, l.cost,
           case when coalesce(e1.occurred_on, e2.occurred_on) between p_from and p_to
                then coalesce(e1.occurred_on, e2.occurred_on) else app.business_day(l.created_at) end as day,
           coalesce(e1.reason, e2.reason, 'unclassified') as reason
      from led l
      left join public.waste_entries e1 on e1.stock_ledger_id = l.id
      left join public.waste_entries e2 on e2.reversal_ledger_id = l.id
     where l.reason = 'spoilage' and l.created_at < v_to
    union all
    select e.inventory_item_id, -e.qty_base, coalesce(e.unit_cost_cents_base, 0),
           case when e.occurred_on between p_from and p_to then e.occurred_on else app.business_day(e.decided_at) end, e.reason
      from public.waste_entries e
     where e.already_consumed and e.status = 'approved' and e.decided_at >= v_from and e.decided_at < v_to
       and (case when p_branch is null then app.in_scope(e.branch_id) else e.branch_id = p_branch end)
  )
  select jsonb_build_object(
    'from', p_from, 'to', p_to, 'branch_id', p_branch, 'costs_visible', v_cost_ok,
    'items', coalesce((select jsonb_agg(jsonb_build_object(
        'inventory_item_id', id, 'name', name, 'unit', unit,
        'opening_qty', closing - period_net, 'closing_qty', closing,
        'receipts_qty', coalesce(receipts, 0), 'adjust_in_qty', coalesce(adj_in, 0), 'adjust_out_qty', coalesce(adj_out, 0),
        'usage_qty', coalesce(usage, 0), 'waste_qty', coalesce(waste, 0), 'stock_take_qty', coalesce(stock_take, 0),
        'waste_after_use_qty', waste_after_use,
        'usage_value_cents', case when v_cost_ok then round(coalesce(usage_value, 0)) end,
        'waste_cost_cents', case when v_cost_ok then round(coalesce(waste_value, 0)) end,
        'waste_after_use_cost_cents', case when v_cost_ok then round(waste_after_use_value) end,
        'unit_cost_cents', case when v_cost_ok then unit_cost end,
        'estimated_cost_rows', coalesce(estimated_rows, 0)) order by name) from items), '[]'::jsonb),
    'daily', coalesce((select jsonb_agg(jsonb_build_object('day', day, 'events', n,
        'cost_cents', case when v_cost_ok then round(cost) end) order by day)
        from (select day, count(*) as n, -sum(delta_qty * cost) as cost from wrows group by day) d), '[]'::jsonb),
    'by_item_reason', coalesce((select jsonb_agg(jsonb_build_object('inventory_item_id', inventory_item_id, 'reason', reason,
        'qty', qty, 'cost_cents', case when v_cost_ok then round(cost) end))
        from (select inventory_item_id, reason, -sum(delta_qty) as qty, -sum(delta_qty * cost) as cost
                from wrows group by 1, 2) r), '[]'::jsonb)
  ) into v_out;
  return v_out;
end $fn$;
revoke all on function public.wastage_report(date, date, uuid) from public;
grant execute on function public.wastage_report(date, date, uuid) to authenticated, service_role;
