-- ============================================================================
-- Tenant delta 0044 — Portal Management → real staff/role authorization
--
-- public.portal_staff (portal_id, membership_id) has existed since 0004 but
-- was never read by anything: a portal's configured access only ever
-- affected its own dedicated kiosk login (portal_user_id), never a real
-- staff member linked to it. This wires it into the same effective-
-- permission pipeline role/extra_permissions already use, so assigning a
-- portal to a staff member is a genuine, server-enforced authorization
-- source — not UI metadata.
-- ============================================================================

-- The top-level 'role' claim (service_role/authenticated/anon) — NOT
-- app_metadata.role (that's app.current_member_role()). This PostgREST
-- setup never populates the per-claim 'request.jwt.claim.role' GUC that
-- has_perm() used to read here (it was always '' <> 'service_role', so
-- that clause never once fired — harmless for RLS itself, since the
-- service_role Postgres role bypasses row security independently of
-- has_perm(), but it silently broke every EXPLICIT has_perm()/service_role
-- check inside a SECURITY DEFINER function body, e.g. set_member_access's
-- and set_portal_staff's below "v_all" anti-escalation short-circuit).
-- The aggregate 'request.jwt.claims' GUC IS populated and carries role at
-- its top level, so read it from there instead.
create or replace function app.jwt_role()
returns text language sql stable as $$
  select nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role'
$$;

create or replace function app.has_perm(p_perm text)
returns boolean language sql stable as $$
  select
    -- service_role bypasses RLS entirely; this covers authenticated portals.
    app.jwt_role() = 'service_role'
    or '*' = any(app.jwt_permissions())
    or p_perm = any(app.jwt_permissions())
    -- transitional: an owner/manager with no explicit permissions still writes.
    or (app.jwt_permissions() = '{}'::text[] and app.can_write())
$$;

-- Effective permissions for a membership = its role preset ∪ extra_permissions
-- ∪ the permissions of every portal it's linked to via portal_staff. '*'
-- anywhere collapses the result to {'*'}. Linking the Super Admin portal
-- (permissions = {'*'}) is refused at the RPC below, so that specific
-- escalation only reaches here if a non-super_admin portal itself was
-- explicitly granted '*' by an Owner — same as today's kiosk-portal path.
create or replace function app.membership_effective_permissions(
  p_role text, p_extra text[], p_membership_id uuid
) returns text[] language sql stable as $$
  with role_perms as (
    select app.compose_permissions(p_role, p_extra) as perms
  ),
  portal_perms as (
    select coalesce(array_agg(distinct perm), '{}'::text[]) as perms
    from public.portal_staff ps
    join public.portals p on p.id = ps.portal_id
    cross join lateral unnest(p.permissions) as perm
    where ps.membership_id = p_membership_id and p.status = 'active'
  )
  select case
    when (select perms from role_perms) @> array['*'] then array['*']
    when (select perms from portal_perms) @> array['*'] then array['*']
    else (
      select coalesce(array_agg(distinct k order by k), '{}'::text[])
      from unnest((select perms from role_perms) || (select perms from portal_perms)) as k
    )
  end
$$;

-- set_member_access now folds in existing portal_staff links so a role
-- change never silently drops portal-derived access (or the anti-escalation
-- check below it never silently ignores it either).
create or replace function public.set_member_access(
  p_membership_id uuid, p_role text, p_extra text[] default '{}'
) returns text[]
language plpgsql security definer set search_path = public, app as $$
declare
  v_effective text[];
  v_key text;
  v_actor text[] := app.jwt_permissions();
  v_all boolean := ('*' = any(v_actor)) or app.jwt_role() = 'service_role';
begin
  if not app.has_perm('permissions.assign') then
    raise exception 'forbidden' using errcode = 'insufficient_privilege';
  end if;
  if not exists (select 1 from public.roles where key = p_role) then
    raise exception 'unknown_role: %', p_role using errcode = 'foreign_key_violation';
  end if;

  v_effective := app.membership_effective_permissions(p_role, p_extra, p_membership_id);

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

-- Replace the full set of staff memberships linked to one portal.
-- service_role-only (the API route re-checks the caller's own permissions
-- in JS first, same pattern as /api/staff/access) — the anti-escalation
-- check here is a second, independent backstop for a direct RPC caller.
-- Returns one row per AFFECTED membership (old ∪ new — a member being
-- unlinked needs its permissions recomputed too), so the API can back-fill
-- every affected Auth user's app_metadata.permissions in one round trip.
create or replace function public.set_portal_staff(
  p_portal_id uuid, p_membership_ids uuid[]
) returns table(membership_id uuid, user_id uuid, effective text[])
language plpgsql security definer set search_path = public, app as $$
declare
  v_portal record;
  v_actor text[] := app.jwt_permissions();
  v_all boolean := ('*' = any(v_actor)) or app.jwt_role() = 'service_role';
  v_key text;
  v_new uuid[] := coalesce(p_membership_ids, '{}'::uuid[]);
begin
  if not app.has_perm('portals.update') then
    raise exception 'forbidden' using errcode = 'insufficient_privilege';
  end if;

  select id, type, status, permissions into v_portal from public.portals where id = p_portal_id;
  if not found then
    raise exception 'portal_not_found' using errcode = 'no_data_found';
  end if;
  if v_portal.type = 'super_admin' then
    raise exception 'the Super Admin portal cannot be assigned to staff' using errcode = 'insufficient_privilege';
  end if;

  if not v_all then
    foreach v_key in array v_portal.permissions loop
      if not (v_key = any(v_actor)) then
        raise exception 'cannot grant a permission you do not hold: %', v_key
          using errcode = 'insufficient_privilege';
      end if;
    end loop;
  end if;

  -- Affected = currently linked ∪ about-to-be-linked; both sides need a
  -- fresh effective-permission read after the swap below.
  create temp table _affected(id uuid) on commit drop;
  insert into _affected select ps.membership_id from public.portal_staff ps where ps.portal_id = p_portal_id;
  insert into _affected select unnest(v_new) except select id from _affected;

  delete from public.portal_staff where portal_id = p_portal_id;
  insert into public.portal_staff (portal_id, membership_id)
    select p_portal_id, m_id from unnest(v_new) as m_id
    on conflict do nothing;

  perform app.log_action('portal.staff', 'portals', p_portal_id::text, null,
                         jsonb_build_object('membership_ids', v_new));

  return query
    select m.id, m.user_id,
           app.membership_effective_permissions(m.role::text, m.extra_permissions, m.id)
    from public.memberships m
    where m.id in (select id from _affected);
end $$;
revoke all on function public.set_portal_staff(uuid, uuid[]) from public, authenticated, anon;
grant execute on function public.set_portal_staff(uuid, uuid[]) to service_role;

-- Recompute one membership's effective permissions from its CURRENT stored
-- role/extra_permissions/portal_staff links. Used after editing or deleting
-- a portal, to re-sync every staff member linked to it (set_portal_staff
-- above only covers the membership list changing, not the portal's own
-- permissions changing under an unchanged staff list). No permission gate:
-- read-only, and only ever called with the service_role tenant client from
-- a route that already required portals.update to reach this point.
create or replace function public.membership_effective_permissions(
  p_membership_id uuid
) returns table(user_id uuid, effective text[])
language sql stable security definer set search_path = public, app as $$
  select m.user_id, app.membership_effective_permissions(m.role::text, m.extra_permissions, m.id)
  from public.memberships m
  where m.id = p_membership_id
$$;
revoke all on function public.membership_effective_permissions(uuid) from public, authenticated, anon;
grant execute on function public.membership_effective_permissions(uuid) to service_role;
