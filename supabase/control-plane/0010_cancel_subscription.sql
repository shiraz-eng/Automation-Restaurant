-- ============================================================================
-- Control-plane 0010 — self-service subscription cancellation
--
-- Mirrors sync_subscription's own pattern (service_role-only RPC, never a
-- direct client write to subscriptions) for the one new mutation self-
-- service cancel needs: marking a subscription canceled immediately, for
-- tenants with no real Stripe subscription behind them (mock-payment mode).
-- A REAL Stripe subscription is cancelled through Stripe itself
-- (stripe.subscriptions.update cancel_at_period_end) — sync_subscription
-- already picks up the resulting webhook event, so no new RPC is needed
-- for that path.
-- ============================================================================

create or replace function public.cancel_subscription(p_tenant_id uuid)
returns void
language plpgsql
security definer
set search_path = public, app
as $$
begin
  update public.subscriptions
     set status     = 'canceled',
         updated_at = now()
   where tenant_id = p_tenant_id;
end;
$$;

revoke all on function public.cancel_subscription(uuid) from public, anon, authenticated;
grant execute on function public.cancel_subscription(uuid) to service_role;
