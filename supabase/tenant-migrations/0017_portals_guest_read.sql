-- 0017: let guests read the name of active checkout-type portals, so the
-- customer order-tracking page can tell them which counter to pay at once
-- their order is ready. Idempotent.
drop policy if exists guest_read on public.portals;
create policy guest_read on public.portals for select
  using (type = 'checkout' and status = 'active');
