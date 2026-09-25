-- 0074: deals in Restaurant Performance.
--
-- revenue_by_category only counted à-la-carte lines (deal_id is null), so a
-- restaurant selling mostly combos saw its category chart miss that money
-- entirely, and nothing on the performance view listed deals at all.
--
-- * revenue_by_category now adds one "Deals" row: the deals' own header
--   lines (the price the customer paid for the combo), never the component
--   lines inside a deal, so nothing is double counted.
-- * deal_sales(from, to): units, orders and revenue per deal — totals only,
--   readable with the same keys as the other performance reports (0072)
--   plus deals.view. Cost/margin per deal still comes from
--   deal_profitability(), which needs cost visibility.

create or replace function public.revenue_by_category(p_from timestamptz, p_to timestamptz)
returns table (category_id uuid, category_name text, revenue_cents int, qty_sold int)
language plpgsql stable security definer set search_path = public, app as $fn$
begin
  if not (app.has_perm('orders.view') or app.has_perm('analytics.view') or app.has_perm('finance.view')
          or app.has_perm('finance.view_profit') or app.has_perm('finance.view_cogs') or app.is_staff()) then
    raise exception 'forbidden' using errcode = 'insufficient_privilege';
  end if;
  return query
    select x.cat_id, x.cat_name, x.cat_revenue, x.cat_qty from (
      select coalesce(mc.id, '00000000-0000-0000-0000-000000000000'::uuid) as cat_id,
             coalesce(mc.name, 'Uncategorized') as cat_name,
             sum(l.line_total_cents)::int as cat_revenue,
             sum(l.qty)::int as cat_qty
        from public.order_lines l
        join public.orders o on o.id = l.order_id
        left join public.menu_items mi on mi.id = l.menu_item_id
        left join public.menu_categories mc on mc.id = mi.category_id
       where l.deal_id is null and l.menu_item_id is not null
         and o.status in ('served','paid')
         and coalesce(o.paid_at, o.created_at) >= p_from and coalesce(o.paid_at, o.created_at) < p_to
       group by mc.id, mc.name
      union all
      select 'dea10000-0000-0000-0000-000000000000'::uuid, 'Deals',
             sum(l.line_total_cents)::int, sum(l.qty)::int
        from public.order_lines l
        join public.orders o on o.id = l.order_id
       where l.deal_id is not null and l.menu_item_id is null
         and o.status in ('served','paid')
         and coalesce(o.paid_at, o.created_at) >= p_from and coalesce(o.paid_at, o.created_at) < p_to
      having count(*) > 0
    ) x
    order by x.cat_revenue desc;
end $fn$;

create or replace function public.deal_sales(p_from timestamptz, p_to timestamptz)
returns table (deal_id uuid, name text, orders_count int, qty_sold int, revenue_cents int)
language plpgsql stable security definer set search_path = public, app as $fn$
begin
  if not (app.has_perm('orders.view') or app.has_perm('analytics.view') or app.has_perm('finance.view')
          or app.has_perm('finance.view_profit') or app.has_perm('finance.view_cogs') or app.has_perm('deals.view')
          or app.is_staff()) then
    raise exception 'forbidden' using errcode = 'insufficient_privilege';
  end if;
  return query
    select l.deal_id,
           coalesce(max(d.name), max(l.name_snapshot)) as deal_name,
           count(distinct l.order_id)::int,
           sum(l.qty)::int,
           sum(l.line_total_cents)::int
      from public.order_lines l
      join public.orders o on o.id = l.order_id
      left join public.deals d on d.id = l.deal_id
     where l.deal_id is not null and l.menu_item_id is null
       and o.status in ('served','paid')
       and coalesce(o.paid_at, o.created_at) >= p_from and coalesce(o.paid_at, o.created_at) < p_to
     group by l.deal_id
     order by sum(l.line_total_cents) desc;
end $fn$;
revoke all on function public.deal_sales(timestamptz, timestamptz) from public;
grant execute on function public.deal_sales(timestamptz, timestamptz) to authenticated, service_role;
