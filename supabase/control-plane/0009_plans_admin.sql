-- ============================================================================
-- Control-plane 0009 — Plans & Pricing become real, admin-editable DB rows
--
-- Until now, plan tiers/prices/features lived only in packages/shared's PLANS
-- constant — fine for a fixed 3-tier launch, but not editable without a code
-- deploy. This migration makes public.plans the single authoritative source:
-- subscriptions.tier moves from a closed app.plan_tier enum to a text FK
-- against plans.tier, so an admin can add/edit/retire plans without touching
-- code. Behavior-preserving: the 3 seed rows below match packages/shared's
-- current values exactly, so nothing displayed/charged changes on cutover.
-- ============================================================================

create table public.plans (
  id                       uuid primary key default gen_random_uuid(),
  tier                     text not null unique,
  name                     text not null,
  blurb                    text,
  -- null = "contact sales" (no self-service price), matching Enterprise today.
  price_monthly_cents      int,
  price_annual_cents       int,
  currency                 text not null default 'usd',
  limits                   jsonb not null default '{}'::jsonb,
  highlights               text[] not null default '{}',
  -- Subset of the app's fixed FeatureKey union (packages/shared) this plan
  -- includes. Admin can toggle these, but cannot invent new keys — a
  -- capability only exists if the app actually enforces/implements it.
  features                 text[] not null default '{}',
  stripe_price_id_monthly  text,
  stripe_price_id_annual   text,
  is_active                boolean not null default true,
  sort_order               int not null default 0,
  created_at               timestamptz not null default now(),
  updated_at                timestamptz not null default now()
);

create or replace function app.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger plans_set_updated_at
  before update on public.plans
  for each row execute function app.set_updated_at();

alter table public.plans enable row level security;

create policy anon_read_active on public.plans
  for select using (is_active);

create policy super_admin_all on public.plans
  for all using (app.is_super_admin()) with check (app.is_super_admin());

grant select on public.plans to anon, authenticated;

insert into public.plans (tier, name, blurb, price_monthly_cents, price_annual_cents, limits, highlights, features, sort_order) values
  ('starter', 'Starter', 'For small restaurants and cafés.', 4900, 3900,
   '{"users":"5","branches":"1","tables":"20","support":"Email"}'::jsonb,
   array['POS & orders', 'QR table ordering', 'Tables & floor', 'Basic reports'],
   array[]::text[], 0),
  ('growth', 'Professional', 'For growing restaurants.', 12900, 10300,
   '{"users":"20","branches":"1","tables":"Unlimited","support":"Priority"}'::jsonb,
   array['Everything in Starter', 'Kitchen display + real-time', 'Inventory & recipes', 'Staff, customers, reservations', 'Advanced analytics'],
   array['pos.multi_terminal', 'kds.realtime', 'inventory.recipe_deduction', 'menu.branded', 'sync.offline_6h'], 1),
  ('enterprise', 'Enterprise', 'For multi-branch restaurant groups.', null, null,
   '{"users":"Unlimited","branches":"Unlimited","tables":"Unlimited","support":"Dedicated"}'::jsonb,
   array['Everything in Professional', 'Multi-branch management', 'Accounting', 'Custom branding', 'Advanced permissions', 'Enterprise support'],
   array['pos.multi_terminal', 'kds.realtime', 'kds.station_routing', 'inventory.recipe_deduction', 'inventory.predictive_ai', 'menu.branded', 'menu.white_label', 'sync.offline_6h', 'sync.mesh', 'branches.multi'], 2);

-- ── Contact form's table, documented as part of the control-plane boundary
-- (0005's comment) — kept idempotent here (it, and its RLS policy, already
-- exist on this project from an earlier out-of-band setup) so this file
-- still stands alone as the full schema for a fresh control-plane project.
create table if not exists public.contact_messages (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  email      text not null,
  restaurant text,
  message    text not null,
  created_at timestamptz not null default now()
);

alter table public.contact_messages enable row level security;

do $$ begin
  create policy super_admin_read on public.contact_messages
    for select using (app.is_super_admin());
exception when duplicate_object then null;
end $$;

-- ── subscriptions.tier: enum -> text FK against plans.tier ─────────────────
-- tenant_directory depends on this column, so it has to go and come back.
drop view public.tenant_directory;

alter table public.subscriptions
  alter column tier type text using tier::text;

alter table public.subscriptions
  add constraint subscriptions_tier_fkey foreign key (tier) references public.plans(tier);

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

-- ── register_tenant / sync_subscription: drop the ::app.plan_tier casts now
-- that tier is plain text (validity is enforced by the FK above instead). ──
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
  values (v_tenant_id, p_tier,
    coalesce(nullif(p_billing_interval,''),'monthly')::app.billing_interval,
    p_status::app.subscription_status,
    nullif(p_stripe_customer_id,''), nullif(p_stripe_subscription_id,''), p_current_period_end);

  return query select v_tenant_id, v_slug;
end $function$;

create or replace function public.sync_subscription(
  p_stripe_subscription_id text,
  p_tier                   text,
  p_status                 text,
  p_current_period_end     timestamptz
)
returns void
language plpgsql
security definer
set search_path = public, app
as $$
begin
  update public.subscriptions
     set tier               = coalesce(nullif(p_tier, ''), tier),
         status             = p_status::app.subscription_status,
         current_period_end = p_current_period_end,
         updated_at         = now()
   where stripe_subscription_id = p_stripe_subscription_id;
end;
$$;
