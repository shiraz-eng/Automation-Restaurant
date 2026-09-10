-- ============================================================================
-- Tenant delta 0003 — Phase 1: permission system foundation
--
-- Additive only. Introduces app.has_perm() + a permission catalogue. Existing
-- is_staff()/can_write() and all current RLS are untouched, so nothing breaks;
-- later phases move policies onto has_perm().
-- ============================================================================

create or replace function app.jwt_permissions()
returns text[] language sql stable as $$
  select coalesce(
    array(
      select jsonb_array_elements_text(
        nullif(current_setting('request.jwt.claims', true), '')::jsonb #> '{app_metadata,permissions}'
      )
    ),
    '{}'::text[]
  )
$$;

create or replace function app.has_perm(p_perm text)
returns boolean language sql stable as $$
  select
    coalesce(current_setting('request.jwt.claim.role', true), '') = 'service_role'
    or '*' = any(app.jwt_permissions())
    or p_perm = any(app.jwt_permissions())
    or (app.jwt_permissions() = '{}'::text[] and app.can_write())
$$;

drop table if exists app.permission_catalog;  -- moved to public (earlier draft)

create table if not exists public.permission_catalog (
  key   text primary key,
  grp   text not null,
  label text not null
);
insert into public.permission_catalog (key, grp, label) values
  ('orders.view','Orders','View orders'),
  ('orders.create','Orders','Create orders'),
  ('orders.update','Orders','Update orders'),
  ('orders.cancel','Orders','Cancel orders'),
  ('payments.view','Payments','View payments'),
  ('payments.accept','Payments','Accept payment'),
  ('payments.refund','Payments','Refund payment'),
  ('kitchen.view','Kitchen','View kitchen queue'),
  ('kitchen.update_status','Kitchen','Update order/prep status'),
  ('menu.view','Menu','View menu'),
  ('menu.create','Menu','Create menu items'),
  ('menu.update','Menu','Update menu items'),
  ('menu.delete','Menu','Delete menu items'),
  ('stock.view','Stock','View food availability'),
  ('stock.update','Stock','Update food availability'),
  ('attendance.view','Attendance','View attendance'),
  ('attendance.mark','Attendance','Mark attendance'),
  ('staff.view','Staff','View staff'),
  ('staff.create','Staff','Create staff'),
  ('staff.update','Staff','Update staff'),
  ('staff.delete','Staff','Delete staff'),
  ('reviews.view','Reviews','View customer reviews'),
  ('reviews.analytics','Reviews','View review analytics'),
  ('reviews.respond','Reviews','Respond to reviews'),
  ('reviews.moderate','Reviews','Moderate reviews'),
  ('reports.view','Reports','View reports'),
  ('settings.view','Settings','View settings'),
  ('settings.update','Settings','Update settings'),
  ('portals.view','Portal Management','View portals'),
  ('portals.create','Portal Management','Create portals'),
  ('portals.update','Portal Management','Update portals'),
  ('portals.disable','Portal Management','Enable/disable portals'),
  ('portals.credentials','Portal Management','Manage portal credentials')
on conflict (key) do update set grp = excluded.grp, label = excluded.label;

alter table public.permission_catalog enable row level security;
drop policy if exists staff_read on public.permission_catalog;
create policy staff_read on public.permission_catalog for select using (app.is_staff());
