-- ============================================================================
-- Control-plane 0008 — register_tenant slug suffix without pgcrypto
--
-- The slug-collision fallback used gen_random_bytes() (pgcrypto), which isn't
-- enabled in the control-plane project. Switch to md5(random()) so no extension
-- is required. Also enable pgcrypto for good measure.
-- ============================================================================

create extension if not exists pgcrypto;

create or replace function public.register_tenant(
  p_restaurant_name text, p_slug text, p_tier text, p_billing_interval text,
  p_status text, p_stripe_customer_id text, p_stripe_subscription_id text,
  p_current_period_end timestamptz, p_owner_email text, p_region text
) returns table(tenant_id uuid, slug text)
language plpgsql security definer set search_path to 'public', 'app' as $function$
declare v_tenant_id uuid; v_slug text := p_slug;
begin
  select s.tenant_id, t.slug into v_tenant_id, v_slug
    from public.subscriptions s join public.tenants t on t.id = s.tenant_id
   where s.stripe_subscription_id = nullif(p_stripe_subscription_id, '');
  if found then return query select v_tenant_id, v_slug; return; end if;

  v_slug := p_slug;
  loop
    begin
      insert into public.tenants (restaurant_name, slug, status, owner_email, region)
      values (p_restaurant_name, v_slug, 'provisioning', lower(p_owner_email), p_region)
      returning id into v_tenant_id;
      exit;
    exception when unique_violation then
      v_slug := p_slug || '-' || substr(md5(random()::text || clock_timestamp()::text), 1, 5);
    end;
  end loop;

  insert into public.subscriptions (tenant_id, tier, billing_interval, status,
    stripe_customer_id, stripe_subscription_id, current_period_end)
  values (v_tenant_id, p_tier::app.plan_tier,
    coalesce(nullif(p_billing_interval,''),'monthly')::app.billing_interval,
    p_status::app.subscription_status,
    nullif(p_stripe_customer_id,''), nullif(p_stripe_subscription_id,''), p_current_period_end);

  return query select v_tenant_id, v_slug;
end $function$;
