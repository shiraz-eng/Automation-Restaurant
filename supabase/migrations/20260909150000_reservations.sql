-- ============================================================================
-- 0004_reservations.sql
-- Table booking. Any tenant member can read and write; RLS scopes to the tenant.
-- ============================================================================

create type app.reservation_status as enum (
  'pending', 'confirmed', 'arrived', 'seated', 'completed', 'cancelled', 'no_show'
);

create table public.reservations (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants(id) on delete cascade,
  customer_name text not null,
  phone         text,
  email         text,
  party_size    int not null check (party_size > 0),
  reserved_at   timestamptz not null,
  duration_min  int not null default 90 check (duration_min > 0),
  table_label   text,
  occasion      text,
  notes         text,
  status        app.reservation_status not null default 'pending',
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index reservations_tenant_time_idx on public.reservations(tenant_id, reserved_at);
create index reservations_tenant_status_idx on public.reservations(tenant_id, status);

alter table public.reservations enable row level security;

create policy tenant_read on public.reservations
  for select using (tenant_id = app.current_tenant_id());

create policy tenant_write on public.reservations
  for all
  using (tenant_id = app.current_tenant_id() and app.current_member_role() is not null)
  with check (tenant_id = app.current_tenant_id() and app.current_member_role() is not null);

-- let the browser client omit tenant_id on insert (filled from the JWT, can't be spoofed)
alter table public.reservations alter column tenant_id set default app.current_tenant_id();
