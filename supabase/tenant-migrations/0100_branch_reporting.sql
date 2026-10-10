-- ============================================================================
-- 0100 — Multi-branch: one row per branch for the group dashboard and the
-- Branch comparison page.
--
-- Same authoritative sources as the Finance module: sales, food cost and
-- expenses come from the ledger (financial_events), so the branch rows add up
-- exactly to the consolidated Finance overview — every ledger line belongs to
-- one branch, nothing is counted twice. Organization-wide ledger lines (no
-- branch: supplier payments, credit notes, manual corrections) are reported
-- separately by the caller, never spread across branches.
-- Rows only for branches the login may use (and, with a selection, only those).
-- ============================================================================

create or replace function public.branch_summary(p_from date, p_to date)
returns table (
  branch_id uuid, code text, name text, status text, is_default boolean,
  orders_count int, net_sales_cents bigint, cogs_cents bigint, expenses_cents bigint,
  payments_cents bigint, open_low_stock int, payables_outstanding_cents bigint,
  last_closed_day date, unclosed_days int, cash_difference_cents bigint
)
language plpgsql stable security definer set search_path = public, app as $fn$
begin
  if not (app.has_perm('finance.view') or app.has_perm('finance.view_profit') or app.has_perm('branches.view') or app.can_write()) then
    raise exception 'forbidden' using errcode = 'insufficient_privilege';
  end if;
  return query
  select b.id, b.code, b.name, b.status, b.is_default,
         (select count(*)::int from public.orders o
           where o.branch_id = b.id and o.status in ('served', 'paid')
             and app.business_day(coalesce(o.paid_at, o.created_at)) between p_from and p_to),
         coalesce((select sum(e.signed_cents) from public.financial_events e where e.branch_id = b.id and e.category = 'revenue' and e.business_date between p_from and p_to), 0)::bigint,
         coalesce((select sum(e.signed_cents) from public.financial_events e where e.branch_id = b.id and e.category = 'cogs' and e.business_date between p_from and p_to), 0)::bigint,
         coalesce((select sum(e.signed_cents) from public.financial_events e where e.branch_id = b.id and e.category = 'expense' and e.business_date between p_from and p_to), 0)::bigint,
         coalesce((select sum(e.signed_cents) from public.financial_events e where e.branch_id = b.id and e.category = 'payment' and e.business_date between p_from and p_to), 0)::bigint,
         (select count(*)::int from public.low_stock_events l where l.branch_id = b.id and l.status = 'open'),
         coalesce((select sum(app.invoice_outstanding_cents(si.id)) from public.supplier_invoices si
                    where si.branch_id = b.id and si.status in ('approved', 'partially_paid')), 0)::bigint,
         (select max(c.business_date) from public.daily_closings c where c.branch_id = b.id and c.status = 'closed'),
         (select count(distinct e.business_date)::int from public.financial_events e
           where e.branch_id = b.id and e.category = 'revenue'
             and e.business_date between greatest(p_from, app.business_day(now()) - 14) and least(p_to, app.business_day(now()) - 1)
             and not exists (select 1 from public.daily_closings c where c.branch_id = b.id and c.business_date = e.business_date and c.status = 'closed')),
         coalesce((select sum(c.difference_cents) from public.daily_closings c
                    where c.branch_id = b.id and c.status = 'closed' and c.business_date between p_from and p_to), 0)::bigint
    from public.branches b
   where b.status <> 'archived' and app.in_scope(b.id)
   order by b.is_default desc, b.name;
end $fn$;
revoke all on function public.branch_summary(date, date) from public;
grant execute on function public.branch_summary(date, date) to authenticated, service_role;
