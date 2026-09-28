-- ============================================================================
-- 0076 — Restaurant Performance dates follow the restaurant's timezone
--
-- expense_date and sales_by_day work in whole dates, but the database runs
-- in UTC. Converting the dashboard's period bounds with a plain ::date (UTC)
-- put them a day off for any restaurant east of UTC (e.g. Asia/Karachi):
-- "Today" also counted yesterday's expenses, and sales_by_day stopped at
-- the UTC date, so the first hours of a new local day were missing.
--
--   * app.local_date(ts): the calendar date of ts in the restaurant's
--     timezone (business_settings.timezone, UTC if unset).
--   * period_profitability(): an expense counts when its date falls in
--     [local date of p_from, local date of the last instant before p_to].
--     Works for a midnight-exclusive p_to and for p_to = now().
--   * sales_by_day(): capped at the restaurant's local today.
--   * expenses joins the realtime publication so the dashboard updates live.
-- ============================================================================

create or replace function app.local_date(p_ts timestamptz default now())
returns date language sql stable set search_path = public, app as $fn$
  select (p_ts at time zone coalesce((select timezone from public.business_settings where id), 'UTC'))::date
$fn$;

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
      -- expense_date is a plain local date: count it when it falls between
      -- the local date of p_from and the local date of the last instant
      -- before p_to (so a midnight p_to excludes the next day, and
      -- p_to = now() still includes today).
      select coalesce(sum(amount_cents),0)::int as expenses_cents
        from public.expenses
       where expense_date >= app.local_date(p_from)
         and expense_date <= app.local_date(p_to - interval '1 microsecond')
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

create or replace function public.sales_by_day(p_from date, p_to date)
returns table(business_date date, gross_sales_cents integer, discount_cents integer, refunded_cents integer, net_sales_cents integer, orders_count integer)
language plpgsql stable security definer set search_path = public, app as $function$
begin
  if not (app.has_perm('orders.view') or app.has_perm('analytics.view') or app.has_perm('finance.view')
          or app.has_perm('finance.view_profit') or app.has_perm('finance.view_cogs') or app.is_staff()) then
    raise exception 'forbidden' using errcode = 'insufficient_privilege';
  end if;
  return query
    select d.day::date,
           (x.s->>'gross_sales_cents')::int, (x.s->>'discounts_cents')::int,
           (x.s->>'refunds_cents')::int, (x.s->>'net_sales_cents')::int, (x.s->>'order_count')::int
      from generate_series(p_from::timestamp, least(p_to, app.local_date())::timestamp, interval '1 day') as d(day),
           lateral (select app.day_sales(d.day::date) as s) x
     order by d.day;
end $function$;

-- Live dashboard: the Restaurant Performance panel re-reads its figures when
-- orders, payments or expenses change (orders/payments are already published).
do $$
begin
  if not exists (select 1 from pg_publication_tables
                  where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'expenses') then
    alter publication supabase_realtime add table public.expenses;
  end if;
end $$;
