-- ============================================================================
-- 0079 — tax collected per period
--
-- Restaurant Performance shows net sales before tax. period_tax() gives the
-- tax collected on the same orders (served/paid, by paid time or else
-- creation time, exactly like period_profitability) and the sales total
-- including tax, so the dashboard can show both. Tax is money owed to the
-- tax authority, not income: it is never part of net sales or profit.
-- ============================================================================

create or replace function public.period_tax(p_from timestamptz, p_to timestamptz)
returns table (tax_cents integer, sales_incl_tax_cents integer, orders_count integer)
language plpgsql stable security definer set search_path = public, app as $fn$
begin
  if not (app.has_perm('orders.view') or app.has_perm('analytics.view') or app.has_perm('finance.view')
          or app.has_perm('finance.view_profit') or app.has_perm('finance.view_cogs') or app.is_staff()) then
    raise exception 'forbidden' using errcode = 'insufficient_privilege';
  end if;
  return query
    select coalesce(sum(o.tax_cents), 0)::int,
           coalesce(sum(o.subtotal_cents - o.discount_cents - coalesce(o.refunded_cents, 0) + o.tax_cents), 0)::int,
           count(*)::int
      from public.orders o
     where o.status in ('served', 'paid')
       and coalesce(o.paid_at, o.created_at) >= p_from and coalesce(o.paid_at, o.created_at) < p_to;
end $fn$;
revoke all on function public.period_tax(timestamptz, timestamptz) from public;
grant execute on function public.period_tax(timestamptz, timestamptz) to authenticated, service_role;
