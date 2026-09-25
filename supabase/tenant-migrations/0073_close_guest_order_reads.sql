-- 0073: SECURITY — guests could read every order.
--
-- To let a customer track their own order, orders / order_lines /
-- table_sessions had  guest_read ... using (true), meant as "whoever holds
-- the order id". But using (true) doesn't require the id: anyone with the
-- restaurant's public key (it ships in the web page) could list EVERY
-- order with customer names, notes, totals and payment methods. The
-- checkout-counter rule on portals likewise exposed those logins' emails
-- and permission lists.
--
-- Tracking now goes through track_order(order_id): it returns that one
-- order (and the checkout counters' names) only to someone who already
-- has its id — the unguessable uuid in their tracking link. The open read
-- rules are removed. Placing orders is unaffected (place_order runs as
-- security definer).

create or replace function public.track_order(p_order_id uuid)
returns jsonb language sql stable security definer set search_path = public, app as $fn$
  select jsonb_build_object(
    'id', o.id,
    'order_number', o.order_number,
    'table_label', o.table_label,
    'customer_name', o.customer_name,
    'status', o.status,
    'subtotal_cents', o.subtotal_cents,
    'tax_cents', o.tax_cents,
    'total_cents', o.total_cents,
    'created_at', o.created_at,
    'pickup_counter_portal_id', o.pickup_counter_portal_id,
    'order_lines', coalesce((
      select jsonb_agg(jsonb_build_object('name_snapshot', l.name_snapshot, 'qty', l.qty, 'line_total_cents', l.line_total_cents)
                       order by l.id)
        from public.order_lines l where l.order_id = o.id), '[]'::jsonb),
    'counters', coalesce((
      select jsonb_agg(jsonb_build_object('id', p.id, 'name', p.name) order by p.name)
        from public.portals p where p.type = 'checkout' and p.status = 'active'), '[]'::jsonb)
  )
  from public.orders o
  where o.id = p_order_id;
$fn$;
revoke all on function public.track_order(uuid) from public;
grant execute on function public.track_order(uuid) to anon, authenticated, service_role;

drop policy if exists guest_read on public.orders;
drop policy if exists guest_read on public.order_lines;
drop policy if exists guest_read on public.table_sessions;
drop policy if exists guest_read on public.portals;
