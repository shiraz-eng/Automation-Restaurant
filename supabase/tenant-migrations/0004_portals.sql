-- ============================================================================
-- Tenant delta 0004 — Phase 2: portal entity
-- ============================================================================

do $$ begin
  create type app.portal_type as enum
    ('super_admin', 'checkout', 'kitchen', 'attendance', 'manager', 'custom');
exception when duplicate_object then null; end $$;

create table if not exists public.portals (
  id             uuid primary key default gen_random_uuid(),
  name           text not null,
  type           app.portal_type not null default 'custom',
  route_key      text not null unique,
  status         text not null default 'active' check (status in ('active', 'disabled')),
  permissions    text[] not null default '{}',
  portal_user_id uuid,
  force_pw_change boolean not null default false,
  last_login_at  timestamptz,
  created_at     timestamptz not null default now(),
  created_by     uuid
);
create index if not exists portals_route_idx on public.portals(route_key);

create table if not exists public.portal_staff (
  portal_id     uuid not null references public.portals(id) on delete cascade,
  membership_id uuid not null references public.memberships(id) on delete cascade,
  primary key (portal_id, membership_id)
);

create or replace function app.current_portal_id()
returns uuid language sql stable as $$
  select nullif(
    nullif(current_setting('request.jwt.claims', true), '')::jsonb #>> '{app_metadata,portal_id}',
    ''
  )::uuid
$$;

alter table public.portals enable row level security;
alter table public.portal_staff enable row level security;

drop policy if exists portals_read on public.portals;
drop policy if exists portals_write on public.portals;
drop policy if exists portal_staff_read on public.portal_staff;
drop policy if exists portal_staff_write on public.portal_staff;
create policy portals_read on public.portals for select
  using (app.has_perm('portals.view') or id = app.current_portal_id());
create policy portals_write on public.portals for all
  using (app.has_perm('portals.update')) with check (app.has_perm('portals.update'));
create policy portal_staff_read on public.portal_staff for select
  using (app.has_perm('portals.view') or portal_id = app.current_portal_id());
create policy portal_staff_write on public.portal_staff for all
  using (app.has_perm('portals.update')) with check (app.has_perm('portals.update'));

do $$ begin
  execute 'create trigger audit after insert or update or delete on public.portals for each row execute function app.audit_row()';
exception when duplicate_object then null; end $$;
do $$ begin
  execute 'create trigger audit after insert or update or delete on public.portal_staff for each row execute function app.audit_row()';
exception when duplicate_object then null; end $$;

-- Implicit Super Admin portal (owner). Idempotent.
insert into public.portals (name, type, route_key, permissions)
select 'Super Admin', 'super_admin', 'admin', array['*']
where not exists (select 1 from public.portals where route_key = 'admin');
