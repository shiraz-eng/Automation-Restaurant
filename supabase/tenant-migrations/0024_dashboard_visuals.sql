-- 0024: Dashboard visual expansion — revenue mix (by category), payment
-- mix, and customer-experience averages. Top products reuses the existing
-- item_profitability(); staff attendance reuses the existing
-- attendance_roster()/attendance_month_summary() — no new logic for either.

create or replace function public.revenue_by_category(p_from timestamptz, p_to timestamptz)
returns table (category_id uuid, category_name text, revenue_cents int, qty_sold int)
language plpgsql stable security definer set search_path = public, app as $fn$
begin
  if not (app.has_perm('orders.view') or app.is_staff()) then
    raise exception 'forbidden' using errcode = 'insufficient_privilege';
  end if;
  return query
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
     order by sum(l.line_total_cents) desc;
end $fn$;
revoke all on function public.revenue_by_category(timestamptz, timestamptz) from public;
grant execute on function public.revenue_by_category(timestamptz, timestamptz) to authenticated, service_role;

create or replace function public.payment_mix(p_from timestamptz, p_to timestamptz)
returns table (method text, revenue_cents int, orders_count int)
language plpgsql stable security definer set search_path = public, app as $fn$
begin
  if not (app.has_perm('orders.view') or app.is_staff()) then
    raise exception 'forbidden' using errcode = 'insufficient_privilege';
  end if;
  return query
    select coalesce(o.payment_method, 'unknown') as pm,
           sum(o.total_cents)::int as pm_revenue,
           count(*)::int as pm_count
      from public.orders o
     where o.status = 'paid'
       and o.paid_at >= p_from and o.paid_at < p_to
     group by coalesce(o.payment_method, 'unknown')
     order by sum(o.total_cents) desc;
end $fn$;
revoke all on function public.payment_mix(timestamptz, timestamptz) from public;
grant execute on function public.payment_mix(timestamptz, timestamptz) to authenticated, service_role;

create or replace function public.feedback_summary(p_from timestamptz, p_to timestamptz)
returns table (
  responses int, avg_overall numeric, avg_food numeric, avg_service numeric,
  avg_cleanliness numeric, avg_speed numeric, avg_ambiance numeric
)
language plpgsql stable security definer set search_path = public, app as $fn$
begin
  if not (app.has_perm('orders.view') or app.is_staff()) then
    raise exception 'forbidden' using errcode = 'insufficient_privilege';
  end if;
  return query
    select count(*)::int,
           round(avg(f.overall)::numeric, 2),
           round(avg(f.food)::numeric, 2),
           round(avg(f.service)::numeric, 2),
           round(avg(f.cleanliness)::numeric, 2),
           round(avg(f.speed)::numeric, 2),
           round(avg(f.ambiance)::numeric, 2)
      from public.feedback f
     where f.created_at >= p_from and f.created_at < p_to;
end $fn$;
revoke all on function public.feedback_summary(timestamptz, timestamptz) from public;
grant execute on function public.feedback_summary(timestamptz, timestamptz) to authenticated, service_role;
