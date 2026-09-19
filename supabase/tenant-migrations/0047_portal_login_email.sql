-- ============================================================================
-- Tenant delta 0047 — Portal login email, mirrored for display/edit
--
-- public.portals already carries portal_user_id (the auth.users row backing
-- a kiosk portal's login) and mirrors that login's `permissions` into its
-- own `permissions` column. This does the same for `email`: the actual
-- login email always lives on auth.users (Supabase Auth is the source of
-- truth, and every write path updates it there first), but Portal
-- Management needs to LIST and EDIT it without a separate admin API call
-- per row, so it's mirrored here exactly like `permissions` already is.
-- ============================================================================

alter table public.portals add column if not exists email text;

-- Backfill from the real source of truth (auth.users lives in the same
-- database) — exact, not reconstructed from route_key/slug guesswork.
update public.portals p
   set email = u.email
  from auth.users u
 where u.id = p.portal_user_id
   and p.email is null;
