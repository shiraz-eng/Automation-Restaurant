-- ============================================================================
-- Tenant delta 0008 — P3: back-fill staff Auth users onto their role preset
--
-- Sets app_metadata.permissions on every non-portal staff Auth user to
-- app.compose_permissions(role, extra_permissions). After this runs, RLS and
-- API permission checks are fully "live" for every role — not just the owner
-- and portal logins.
--
--   * The owner keeps ['*'] (their preset is all-access).
--   * A MANAGER is narrowed to the manager preset: no portal management, no
--     settings.update, no permissions.assign, no finance.close_day. This is the
--     intended tightening (spec §5/§7 — "Manager != unlimited"). If a specific
--     manager needs more, grant it via memberships.extra_permissions / the
--     Staff page and re-run this file (idempotent).
--   * Existing sessions keep their old claims until the JWT refreshes (~1h) or
--     the user signs in again. The 0006 policies are additive, so no lockout.
--
-- Depends on 0007. Safe to re-run.
-- ============================================================================

update auth.users u
set raw_app_meta_data =
  coalesce(u.raw_app_meta_data, '{}'::jsonb)
  || jsonb_build_object(
       'role', m.role,
       'permissions', to_jsonb(app.compose_permissions(m.role::text, m.extra_permissions))
     )
from public.memberships m
where m.user_id = u.id
  and coalesce(u.raw_app_meta_data ->> 'kind', '') <> 'portal';
