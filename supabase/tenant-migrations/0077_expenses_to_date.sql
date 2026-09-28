-- ============================================================================
-- 0077 — net profit subtracts all expenses to date
--
-- period_profitability() used to count only expenses dated inside the
-- period, so "Today" subtracted just today's expenses. The owner wants net
-- profit to subtract every expense recorded up to the end of the period
-- being viewed (all earlier expenses included). Everything else in the
-- function is unchanged from 0076.
-- ============================================================================

create or replace function public.period_profitability(p_from timestamptz, p_to timestamptz)
returns table(from_ts timestamptz, to_ts timestamptz, orders_count integer, gross_sales_cents integer, discount_cents integer, refunded_cents integer, net_sales_cents integer, avg_order_cents integer, theoretical_cogs_cents integer, cogs_lines_total integer, cogs_lines_missing integer, gross_profit_cents integer, gross_margin_pct numeric, food_cost_pct numeric, consumption_ledger_cents integer, waste_cents integer, net_adjustment_cents integer, actual_cogs_cents integer, cogs_variance_cents integer, expenses_cents integer, net_profit_cents integer, net_profit_margin_pct numeric)
language plpgsql stable security definer set search_path = public, app as $function$
begin
  if not (app.has_perm('finance.view_profit') or app.has_perm('finance.view_cogs') or app.has_perm('inventory.view_cost')) then
    raise exception 'forbidden' using errcode = 'insufficient_privilege';
  end if;
  return query
    with sales as (
      select o.id, o.subtotal_cents, o.discount_cents, coalesce(o.refunded_cents,0) as refunded_cents
        from public.orders o
       where o.status in ('served','paid')
         and coalesce(o.paid_at, o.created_at) >= p_from and coalesce(o.paid_at, o.created_at) < p_to
    ),
    sales_agg as (
      select count(*)::int as orders_count,
             coalesce(sum(sales.subtotal_cents),0)::int as gross_sales_cents,
             coalesce(sum(sales.discount_cents),0)::int as discount_cents,
             coalesce(sum(sales.refunded_cents),0)::int as refunded_cents,
             coalesce(sum(sales.subtotal_cents - sales.discount_cents - sales.refunded_cents),0)::int as net_sales_cents
        from sales
    ),
    cogs_agg as (
      select coalesce(sum(l.recipe_cost_cents),0)::int as cogs_cents,
             count(*)::int as lines_total,
             count(*) filter (where l.recipe_cost_cents is null)::int as lines_missing
        from public.order_lines l join sales s on s.id = l.order_id
    ),
    -- Actual ingredient value moved in the period, read off the ledger's own
    -- cost-basis snapshot (unit_cost_cents_base) rather than recomputed.
    ledger_agg as (
      select
        coalesce(sum(abs(delta_qty * unit_cost_cents_base)) filter (where reason = 'order_deduction'), 0)::int as consumption_cents,
        coalesce(sum(abs(delta_qty * unit_cost_cents_base)) filter (where reason = 'spoilage'), 0)::int as waste_cents,
        coalesce(sum(delta_qty * unit_cost_cents_base) filter (where reason in ('adjustment','stock_take')), 0)::int as net_adjustment_cents
        from public.stock_ledger
       where created_at >= p_from and created_at < p_to and unit_cost_cents_base is not null
    ),
    exp_agg as (
      -- Net profit subtracts EVERY expense recorded up to the end of the
      -- period (the owner's choice): today/this week/this month include all
      -- earlier expenses too; a past period never counts later expenses.
      -- expense_date is a local date; the end is the local date of the last
      -- instant before p_to (a midnight p_to excludes the next day,
      -- p_to = now() includes today).
      select coalesce(sum(amount_cents),0)::int as expenses_cents
        from public.expenses
       where expense_date <= app.local_date(p_to - interval '1 microsecond')
    )
    select
      p_from, p_to,
      sales_agg.orders_count, sales_agg.gross_sales_cents, sales_agg.discount_cents, sales_agg.refunded_cents,
      sales_agg.net_sales_cents,
      case when sales_agg.orders_count > 0 then round(sales_agg.net_sales_cents::numeric / sales_agg.orders_count)::int else 0 end,
      cogs_agg.cogs_cents, cogs_agg.lines_total, cogs_agg.lines_missing,
      (sales_agg.net_sales_cents - cogs_agg.cogs_cents),
      case when sales_agg.net_sales_cents > 0 then round((sales_agg.net_sales_cents - cogs_agg.cogs_cents)::numeric / sales_agg.net_sales_cents * 1000) / 10 else null end,
      case when sales_agg.net_sales_cents > 0 then round(cogs_agg.cogs_cents::numeric / sales_agg.net_sales_cents * 1000) / 10 else null end,
      ledger_agg.consumption_cents, ledger_agg.waste_cents, ledger_agg.net_adjustment_cents,
      (ledger_agg.consumption_cents + ledger_agg.waste_cents - ledger_agg.net_adjustment_cents),
      (ledger_agg.consumption_cents + ledger_agg.waste_cents - ledger_agg.net_adjustment_cents - cogs_agg.cogs_cents),
      exp_agg.expenses_cents,
      (sales_agg.net_sales_cents - cogs_agg.cogs_cents - exp_agg.expenses_cents),
      case when sales_agg.net_sales_cents > 0 then round((sales_agg.net_sales_cents - cogs_agg.cogs_cents - exp_agg.expenses_cents)::numeric / sales_agg.net_sales_cents * 1000) / 10 else null end
      from sales_agg, cogs_agg, ledger_agg, exp_agg;
end $function$;
