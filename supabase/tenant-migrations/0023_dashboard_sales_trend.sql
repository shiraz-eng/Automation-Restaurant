-- 0023: Dashboard sales trend — monthly line chart (one point per real
-- business day) + a day drill-down into hourly sales, both built on
-- app.day_sales() so the trend line agrees with the existing daily-closing
-- numbers rather than deriving a second definition of "today's sales".

create or replace function public.sales_by_day(p_from date, p_to date)
returns table (
  business_date date, gross_sales_cents int, discount_cents int,
  refunded_cents int, net_sales_cents int, orders_count int
)
language plpgsql stable security definer set search_path = public, app as $fn$
begin
  if not (app.has_perm('orders.view') or app.is_staff()) then
    raise exception 'forbidden' using errcode = 'insufficient_privilege';
  end if;
  return query
    select d.day::date,
           (x.s->>'gross_sales_cents')::int, (x.s->>'discounts_cents')::int,
           (x.s->>'refunds_cents')::int, (x.s->>'net_sales_cents')::int, (x.s->>'order_count')::int
      from generate_series(p_from::timestamp, least(p_to, current_date)::timestamp, interval '1 day') as d(day),
           lateral (select app.day_sales(d.day::date) as s) x
     order by d.day;
end $fn$;
revoke all on function public.sales_by_day(date, date) from public;
grant execute on function public.sales_by_day(date, date) to authenticated, service_role;

create or replace function public.sales_by_hour(p_date date)
returns table (hour_of_day int, net_sales_cents int, orders_count int)
language plpgsql stable security definer set search_path = public, app as $fn$
begin
  if not (app.has_perm('orders.view') or app.is_staff()) then
    raise exception 'forbidden' using errcode = 'insufficient_privilege';
  end if;
  return query
    select h.hr,
           coalesce(sum(o.subtotal_cents - o.discount_cents - coalesce(o.refunded_cents,0)) filter (where o.id is not null), 0)::int,
           count(o.id)::int
      from generate_series(0, 23) as h(hr)
      left join public.orders o
        on o.status in ('served','paid')
       and app.business_day(coalesce(o.paid_at, o.created_at)) = p_date
       and extract(hour from (coalesce(o.paid_at, o.created_at)
             at time zone coalesce((select timezone from public.business_settings where id), 'UTC'))) = h.hr
     group by h.hr
     order by h.hr;
end $fn$;
revoke all on function public.sales_by_hour(date) from public;
grant execute on function public.sales_by_hour(date) to authenticated, service_role;

create or replace function public.orders_on_day(p_date date)
returns table (
  order_id uuid, order_number bigint, status text, channel text, table_label text,
  total_cents int, discount_cents int, event_at timestamptz
)
language plpgsql stable security definer set search_path = public, app as $fn$
begin
  if not (app.has_perm('orders.view') or app.is_staff()) then
    raise exception 'forbidden' using errcode = 'insufficient_privilege';
  end if;
  return query
    select o.id, o.order_number, o.status::text, o.channel::text, o.table_label,
           o.total_cents, o.discount_cents, coalesce(o.paid_at, o.created_at)
      from public.orders o
     where o.status in ('served','paid')
       and app.business_day(coalesce(o.paid_at, o.created_at)) = p_date
     order by coalesce(o.paid_at, o.created_at);
end $fn$;
revoke all on function public.orders_on_day(date) from public;
grant execute on function public.orders_on_day(date) to authenticated, service_role;
