-- ============================================================================
-- 0017_subscription_actions.sql  (control-plane project)
-- Admin-initiated subscription mutations, mock-mode only (mirrors
-- cancel_subscription's shape from 0010) — the real-Stripe path is always
-- driven by the webhook picking up customer.subscription.updated via
-- sync_subscription, never by these RPCs directly. Each logs a readable
-- audit entry via app.log_admin_action (0014).
-- ============================================================================

create or replace function public.reactivate_subscription(p_tenant_id uuid) returns void
language plpgsql security definer set search_path = public, app as $$
declare v_before jsonb; v_after jsonb;
begin
  select to_jsonb(s) into v_before from public.subscriptions s where tenant_id = p_tenant_id;
  update public.subscriptions set status = 'active', updated_at = now() where tenant_id = p_tenant_id;
  select to_jsonb(s) into v_after from public.subscriptions s where tenant_id = p_tenant_id;
  perform app.log_admin_action('subscription.reactivated', 'subscriptions', p_tenant_id::text, v_before, v_after);
end;
$$;
revoke all on function public.reactivate_subscription(uuid) from public, anon, authenticated;
grant execute on function public.reactivate_subscription(uuid) to service_role;

create or replace function public.change_subscription_plan(p_tenant_id uuid, p_tier text, p_billing_interval text) returns void
language plpgsql security definer set search_path = public, app as $$
declare v_before jsonb; v_after jsonb;
begin
  if not exists (select 1 from public.plans where tier = p_tier) then
    raise exception 'unknown_tier: %', p_tier using errcode = 'foreign_key_violation';
  end if;
  select to_jsonb(s) into v_before from public.subscriptions s where tenant_id = p_tenant_id;
  update public.subscriptions
    set tier = p_tier, billing_interval = p_billing_interval::app.billing_interval, updated_at = now()
    where tenant_id = p_tenant_id;
  select to_jsonb(s) into v_after from public.subscriptions s where tenant_id = p_tenant_id;
  perform app.log_admin_action('subscription.plan_changed', 'subscriptions', p_tenant_id::text, v_before, v_after);
end;
$$;
revoke all on function public.change_subscription_plan(uuid, text, text) from public, anon, authenticated;
grant execute on function public.change_subscription_plan(uuid, text, text) to service_role;

create or replace function public.extend_trial(p_tenant_id uuid, p_days int) returns void
language plpgsql security definer set search_path = public, app as $$
declare v_before jsonb; v_after jsonb; v_new_end timestamptz;
begin
  select greatest(coalesce(current_period_end, now()), now()) + make_interval(days => p_days) into v_new_end
    from public.subscriptions where tenant_id = p_tenant_id;
  select to_jsonb(s) into v_before from public.subscriptions s where tenant_id = p_tenant_id;
  update public.subscriptions
    set status = 'trialing', current_period_end = v_new_end, updated_at = now()
    where tenant_id = p_tenant_id;
  select to_jsonb(s) into v_after from public.subscriptions s where tenant_id = p_tenant_id;
  perform app.log_admin_action('subscription.trial_extended', 'subscriptions', p_tenant_id::text, v_before, v_after);
end;
$$;
revoke all on function public.extend_trial(uuid, int) from public, anon, authenticated;
grant execute on function public.extend_trial(uuid, int) to service_role;
