-- ============================================================================
-- 0001_init.sql  ·  Automation Restaurant
-- Shared-schema multi-tenancy with Row Level Security.
--
-- Model
--   * One database. Every tenant-scoped table carries tenant_id.
--   * RLS confines each request to app.current_tenant_id(), read from the
--     Supabase auth JWT (app_metadata.tenant_id), with a GUC fallback
--     (SET LOCAL app.current_tenant_id = '<uuid>') for trusted server jobs.
--   * Cross-tenant writes (provisioning, Stripe reconciliation) go through
--     SECURITY DEFINER functions that only service_role may execute.
--
-- Money is stored as integer minor units (cents). No floats anywhere.
-- Orders / recipes (BOM) / append-only stock ledger / outbox land in 0002.
-- ============================================================================

create extension if not exists pgcrypto;

create schema if not exists app;
grant usage on schema app to anon, authenticated, service_role;

-- ── Identity resolvers used by RLS policies ─────────────────────────────────
create or replace function app.current_tenant_id()
returns uuid
language sql
stable
as $$
  select nullif(
    coalesce(
      nullif(current_setting('request.jwt.claims', true), '')::jsonb #>> '{app_metadata,tenant_id}',
      nullif(current_setting('app.current_tenant_id', true), '')
    ),
    ''
  )::uuid
$$;

create or replace function app.current_member_role()
returns text
language sql
stable
as $$
  select nullif(current_setting('request.jwt.claims', true), '')::jsonb #>> '{app_metadata,role}'
$$;

-- ── Enums ──────────────────────────────────────────────────────────────────
create type app.plan_tier           as enum ('starter', 'growth', 'enterprise');
create type app.billing_interval    as enum ('monthly', 'annual');
create type app.subscription_status as enum ('trialing', 'active', 'past_due', 'canceled', 'incomplete');
create type app.member_role         as enum ('owner', 'manager', 'cashier', 'chef', 'waiter');
create type app.member_status       as enum ('pending', 'active', 'disabled');

-- ── Core identity ──────────────────────────────────────────────────────────
create table public.tenants (
  id              uuid primary key default gen_random_uuid(),
  restaurant_name text not null,
  slug            text not null unique,
  created_at      timestamptz not null default now()
);

create table public.subscriptions (
  id                     uuid primary key default gen_random_uuid(),
  tenant_id              uuid not null unique references public.tenants(id) on delete cascade,
  tier                   app.plan_tier not null,
  billing_interval       app.billing_interval not null default 'monthly',
  status                 app.subscription_status not null default 'incomplete',
  stripe_customer_id     text unique,
  stripe_subscription_id text unique,
  current_period_end     timestamptz,
  updated_at             timestamptz not null default now()
);

create table public.memberships (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references public.tenants(id) on delete cascade,
  user_id    uuid references auth.users(id) on delete set null,
  email      text not null,
  role       app.member_role not null default 'owner',
  status     app.member_status not null default 'pending',
  created_at timestamptz not null default now(),
  unique (tenant_id, email)
);
create index memberships_user_id_idx on public.memberships(user_id);

-- ── Service-only bookkeeping (RLS on, no policy => service_role only) ────────
create table public.webhook_events (
  id          text primary key,          -- Stripe event id (evt_…)
  type        text not null,
  received_at timestamptz not null default now()
);

create table public.onboarding_tokens (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references public.tenants(id) on delete cascade,
  email      text not null,
  token_hash text not null unique,       -- sha256 hex of the emailed random token
  expires_at timestamptz not null,
  used_at    timestamptz,
  created_at timestamptz not null default now()
);

-- ── Tenant domain (minimal for now) ────────────────────────────────────────
create table public.menu_categories (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references public.tenants(id) on delete cascade,
  name       text not null,
  sort_order int not null default 0,
  created_at timestamptz not null default now()
);
create index menu_categories_tenant_idx on public.menu_categories(tenant_id);

create table public.menu_items (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references public.tenants(id) on delete cascade,
  category_id  uuid references public.menu_categories(id) on delete set null,
  name         text not null,
  price_cents  integer not null check (price_cents >= 0),   -- integer minor units
  is_available boolean not null default true,
  created_at   timestamptz not null default now()
);
create index menu_items_tenant_idx on public.menu_items(tenant_id);

create table public.inventory_items (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants(id) on delete cascade,
  name          text not null,
  sku           text,
  unit          text not null default 'unit',
  stock_qty     numeric(14,3) not null default 0,
  min_threshold numeric(14,3) not null default 0,
  supplier_name text,
  created_at    timestamptz not null default now(),
  unique (tenant_id, sku)
);
create index inventory_items_tenant_idx on public.inventory_items(tenant_id);

-- ── Row Level Security ─────────────────────────────────────────────────────
alter table public.tenants            enable row level security;
alter table public.subscriptions      enable row level security;
alter table public.memberships        enable row level security;
alter table public.webhook_events     enable row level security;
alter table public.onboarding_tokens  enable row level security;
alter table public.menu_categories    enable row level security;
alter table public.menu_items         enable row level security;
alter table public.inventory_items    enable row level security;

-- Read-only visibility of your own tenant, billing and team.
create policy tenant_self_read on public.tenants
  for select using (id = app.current_tenant_id());

create policy subscription_read on public.subscriptions
  for select using (tenant_id = app.current_tenant_id());

create policy membership_read on public.memberships
  for select using (tenant_id = app.current_tenant_id());

-- Domain tables: anyone in the tenant reads; owner/manager writes.
do $$
declare
  tbl text;
begin
  foreach tbl in array array['menu_categories', 'menu_items', 'inventory_items']
  loop
    execute format(
      'create policy tenant_read on public.%1$I '
      || 'for select using (tenant_id = app.current_tenant_id());',
      tbl
    );
    execute format(
      'create policy tenant_write on public.%1$I '
      || 'for all using (tenant_id = app.current_tenant_id()) '
      || 'with check (tenant_id = app.current_tenant_id() '
      || 'and app.current_member_role() in (''owner'', ''manager''));',
      tbl
    );
  end loop;
end $$;

-- ── Cross-tenant operations (service_role only) ────────────────────────────
-- Enum-typed inputs are passed as text and cast in the body so PostgREST RPC
-- calls stay simple; an invalid value raises and the caller surfaces it.
create or replace function public.provision_tenant(
  p_restaurant_name        text,
  p_slug                   text,
  p_tier                   text,
  p_billing_interval       text,
  p_status                 text,
  p_stripe_customer_id     text,
  p_stripe_subscription_id text,
  p_current_period_end     timestamptz,
  p_owner_email            text,
  p_claim_token_hash       text,
  p_claim_expires_at       timestamptz
)
returns table (tenant_id uuid, slug text)
language plpgsql
security definer
set search_path = public, app
as $$
declare
  v_tenant_id uuid;
  v_slug      text := p_slug;
  v_cat_id    uuid;
begin
  -- If this subscription was already provisioned, return the existing tenant.
  select s.tenant_id, t.slug
    into v_tenant_id, v_slug
    from public.subscriptions s
    join public.tenants t on t.id = s.tenant_id
   where s.stripe_subscription_id = nullif(p_stripe_subscription_id, '');
  if found then
    return query select v_tenant_id, v_slug;
    return;
  end if;

  -- SELECT ... INTO above nulls its targets when no row matched; restore the slug.
  v_slug := p_slug;

  -- Insert tenant, resolving slug collisions with a short random suffix.
  loop
    begin
      insert into public.tenants (restaurant_name, slug)
      values (p_restaurant_name, v_slug)
      returning id into v_tenant_id;
      exit;
    exception when unique_violation then
      v_slug := p_slug || '-' || substr(encode(gen_random_bytes(4), 'hex'), 1, 5);
    end;
  end loop;

  insert into public.subscriptions (
    tenant_id, tier, billing_interval, status,
    stripe_customer_id, stripe_subscription_id, current_period_end
  )
  values (
    v_tenant_id,
    p_tier::app.plan_tier,
    coalesce(nullif(p_billing_interval, ''), 'monthly')::app.billing_interval,
    p_status::app.subscription_status,
    nullif(p_stripe_customer_id, ''),
    nullif(p_stripe_subscription_id, ''),
    p_current_period_end
  );

  insert into public.memberships (tenant_id, email, role, status)
  values (v_tenant_id, lower(p_owner_email), 'owner', 'pending');

  insert into public.onboarding_tokens (tenant_id, email, token_hash, expires_at)
  values (v_tenant_id, lower(p_owner_email), p_claim_token_hash, p_claim_expires_at);

  -- Seed a minimal catalogue so the portal is not empty on first login.
  insert into public.menu_categories (tenant_id, name)
  values (v_tenant_id, 'Uncategorised')
  returning id into v_cat_id;

  insert into public.menu_items (tenant_id, category_id, name, price_cents, is_available)
  values (v_tenant_id, v_cat_id, 'Sample item', 0, false);

  insert into public.inventory_items (tenant_id, name, unit)
  values (v_tenant_id, 'Sample ingredient', 'kg');

  return query select v_tenant_id, v_slug;
end;
$$;

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
     set tier               = coalesce(nullif(p_tier, '')::app.plan_tier, tier),
         status             = p_status::app.subscription_status,
         current_period_end = p_current_period_end,
         updated_at         = now()
   where stripe_subscription_id = p_stripe_subscription_id;
end;
$$;

revoke all on function public.provision_tenant(
  text, text, text, text, text, text, text, timestamptz, text, text, timestamptz
) from public, anon, authenticated;
revoke all on function public.sync_subscription(text, text, text, timestamptz)
  from public, anon, authenticated;

grant execute on function public.provision_tenant(
  text, text, text, text, text, text, text, timestamptz, text, text, timestamptz
) to service_role;
grant execute on function public.sync_subscription(text, text, text, timestamptz)
  to service_role;
