-- ============================================================================
-- CONTROL-PLANE schema (runs on the ONE central Supabase project).
-- Holds the registry: which restaurant maps to which dedicated project.
-- The domain tables (menu, orders, inventory, ...) now live in each tenant's
-- own project — see supabase/tenant-template/schema.sql.
-- ============================================================================

-- The original 0001 migration created tenants / subscriptions / onboarding_tokens
-- / webhook_events here. Keep those; extend tenants and add the project registry.

alter table public.tenants add column if not exists status            text not null default 'provisioning';
alter table public.tenants add column if not exists owner_email       text;
alter table public.tenants add column if not exists region            text;
alter table public.tenants add column if not exists provisioning_error text;

comment on column public.tenants.status is
  'provisioning | active | failed | suspended';

create table if not exists public.tenant_projects (
  tenant_id      uuid primary key references public.tenants(id) on delete cascade,
  project_ref    text not null unique,
  project_url    text not null,
  anon_key       text not null,
  -- MVP: service_key and db_password are stored in plaintext here. Before real
  -- use, move them to Supabase Vault (vault.create_secret) or an external KMS.
  service_key    text not null,
  db_password    text not null,
  schema_version int  not null default 0,
  created_at     timestamptz not null default now()
);

alter table public.tenant_projects enable row level security; -- service_role only, no policy

-- Lets the web app resolve a slug -> project without exposing secrets: a view
-- with only the public bits, readable by anon.
create or replace view public.tenant_directory
with (security_invoker = off) as
  select
    t.slug,
    t.restaurant_name,
    t.status,
    tp.project_ref,
    tp.project_url,
    tp.anon_key,
    s.tier,
    s.status           as subscription_status,
    s.billing_interval
  from public.tenants t
  join public.tenant_projects tp on tp.tenant_id = t.id
  left join public.subscriptions s on s.tenant_id = t.id
  where t.status = 'active';

grant select on public.tenant_directory to anon, authenticated;

-- ── Slim registration (replaces the old seed-everything provision_tenant) ───
create or replace function public.register_tenant(
  p_restaurant_name        text,
  p_slug                   text,
  p_tier                   text,
  p_billing_interval       text,
  p_status                 text,
  p_stripe_customer_id     text,
  p_stripe_subscription_id text,
  p_current_period_end     timestamptz,
  p_owner_email            text,
  p_region                 text
)
returns table (tenant_id uuid, slug text)
language plpgsql security definer set search_path = public, app
as $$
declare
  v_tenant_id uuid;
  v_slug      text := p_slug;
begin
  select s.tenant_id, t.slug into v_tenant_id, v_slug
    from public.subscriptions s join public.tenants t on t.id = s.tenant_id
   where s.stripe_subscription_id = nullif(p_stripe_subscription_id, '');
  if found then
    return query select v_tenant_id, v_slug;
    return;
  end if;

  v_slug := p_slug;
  loop
    begin
      insert into public.tenants (restaurant_name, slug, status, owner_email, region)
      values (p_restaurant_name, v_slug, 'provisioning', lower(p_owner_email), p_region)
      returning id into v_tenant_id;
      exit;
    exception when unique_violation then
      v_slug := p_slug || '-' || substr(encode(gen_random_bytes(4), 'hex'), 1, 5);
    end;
  end loop;

  insert into public.subscriptions (
    tenant_id, tier, billing_interval, status,
    stripe_customer_id, stripe_subscription_id, current_period_end
  ) values (
    v_tenant_id,
    p_tier::app.plan_tier,
    coalesce(nullif(p_billing_interval, ''), 'monthly')::app.billing_interval,
    p_status::app.subscription_status,
    nullif(p_stripe_customer_id, ''), nullif(p_stripe_subscription_id, ''), p_current_period_end
  );

  return query select v_tenant_id, v_slug;
end;
$$;

revoke all on function public.register_tenant(text,text,text,text,text,text,text,timestamptz,text,text)
  from public, anon, authenticated;
grant execute on function public.register_tenant(text,text,text,text,text,text,text,timestamptz,text,text)
  to service_role;
