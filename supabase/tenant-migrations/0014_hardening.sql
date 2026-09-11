-- ============================================================================
-- Tenant delta 0014 — P9: hardening
--
--   * set_member_access no longer trusts a caller-supplied permission array
--     (it was grantable to `authenticated`, so a browser could pass
--     p_actor_perms => {'*'} and self-escalate). It now derives the actor's
--     permissions from the JWT and is executable by service_role ONLY — the
--     /api/staff/access route is the single caller and re-checks in JS.
--   * clear_force_pw_change() — a portal user clears its own force-password
--     flag after changing the password.
--
-- Depends on 0007 (roles), 0004 (portals). Idempotent.
-- ============================================================================

drop function if exists public.set_member_access(uuid, text, text[], text[]);

create or replace function public.set_member_access(
  p_membership_id uuid, p_role text, p_extra text[] default '{}'
) returns text[]
language plpgsql security definer set search_path = public, app as $$
declare
  v_effective text[];
  v_key text;
  v_actor text[] := app.jwt_permissions();
  -- service_role = the /api/staff/access route, which already ran the JS
  -- anti-escalation check with the caller's verified permissions.
  v_all boolean := ('*' = any(v_actor))
    or coalesce(current_setting('request.jwt.claim.role', true), '') = 'service_role';
begin
  if not app.has_perm('permissions.assign') then
    raise exception 'forbidden' using errcode = 'insufficient_privilege';
  end if;
  if not exists (select 1 from public.roles where key = p_role) then
    raise exception 'unknown_role: %', p_role using errcode = 'foreign_key_violation';
  end if;

  v_effective := app.compose_permissions(p_role, p_extra);

  if not v_all then
    foreach v_key in array v_effective loop
      if not (v_key = any(v_actor)) then
        raise exception 'cannot grant a permission you do not hold: %', v_key
          using errcode = 'insufficient_privilege';
      end if;
    end loop;
  end if;

  update public.memberships
     set role = p_role::app.member_role, extra_permissions = coalesce(p_extra, '{}'::text[])
   where id = p_membership_id;
  if not found then
    raise exception 'membership_not_found' using errcode = 'no_data_found';
  end if;

  perform app.log_action('staff.access', 'memberships', p_membership_id::text, null,
                         jsonb_build_object('role', p_role, 'extra', p_extra));
  return v_effective;
end $$;
revoke all on function public.set_member_access(uuid, text, text[]) from public, authenticated, anon;
grant execute on function public.set_member_access(uuid, text, text[]) to service_role;

create or replace function public.clear_force_pw_change()
returns void language plpgsql security definer set search_path = public, app as $$
declare v_pid uuid := app.current_portal_id();
begin
  if v_pid is null then
    raise exception 'not_a_portal_session' using errcode = 'insufficient_privilege';
  end if;
  update public.portals set force_pw_change = false where id = v_pid;
end $$;
revoke all on function public.clear_force_pw_change() from public;
grant execute on function public.clear_force_pw_change() to authenticated, service_role;
