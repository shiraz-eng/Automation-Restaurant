-- ============================================================================
-- Tenant delta 0053 — Portal sign-in/out tracking + per-staff default shift
-- time + automatic absence marking
--
-- Three independent additions:
--
-- 1. Portal session tracking: portals.last_login_at already existed but was
--    never actually written anywhere — nothing called it. Adds
--    last_logout_at alongside it, and the two SECURITY DEFINER RPCs
--    (portal_record_sign_in/out) the web app now calls right after a
--    successful sign-in and right before sign-out. Both also write a
--    'portal.sign_in'/'portal.sign_out' row via app.log_action(), so the
--    existing Audit log page (already a generic audit_logs viewer) surfaces
--    this history for free — no new report page needed.
--
-- 2. memberships.shift_start_time: a per-staff default expected start time,
--    settable at staff creation/edit. app.recompute_attendance() already
--    computes late_minutes against a scheduled shifts row when one exists
--    for that day; it now falls back to this default when no explicit
--    shift was scheduled, so late detection works without requiring the
--    Owner to build out the Scheduling calendar first.
--
-- 3. attendance_auto_absent_sweep(): for any PAST business day (never
--    today — it isn't over yet) where a member was expected to work (an
--    explicit shift that day, or a default shift_start_time on a day
--    attendance_settings.working_days marks as a working day) and never
--    clocked in or got an explicit status, inserts an 'absent' row with
--    source='auto' — the 'auto' source value already existed in the
--    attendance table's check constraint, unused until now. Called
--    periodically by the API server (apps/api/src/lib/attendanceAutomation.ts),
--    the same setInterval-sweep pattern low-stock/recipe-cost automation
--    already use (apps/api/src/server.ts) — nothing here uses an AI model,
--    the trigger and eligibility are decided entirely in SQL.
-- ============================================================================

alter table public.portals add column if not exists last_logout_at timestamptz;
alter table public.memberships add column if not exists shift_start_time time;

create or replace function public.portal_record_sign_in()
returns void language plpgsql security definer set search_path = public, app as $fn$
declare v_pid uuid := app.current_portal_id();
begin
  -- No-op for a staff (non-portal) login — current_portal_id() is only
  -- set on a 'kind: portal' JWT (schema.sql ~4958), so this is safe to
  -- call unconditionally from the one shared login form.
  if v_pid is null then return; end if;
  update public.portals set last_login_at = now() where id = v_pid;
  perform app.log_action('portal.sign_in', 'portals', v_pid::text);
end $fn$;
revoke all on function public.portal_record_sign_in() from public;
grant execute on function public.portal_record_sign_in() to authenticated, service_role;

create or replace function public.portal_record_sign_out()
returns void language plpgsql security definer set search_path = public, app as $fn$
declare v_pid uuid := app.current_portal_id();
begin
  if v_pid is null then return; end if;
  update public.portals set last_logout_at = now() where id = v_pid;
  perform app.log_action('portal.sign_out', 'portals', v_pid::text);
end $fn$;
revoke all on function public.portal_record_sign_out() from public;
grant execute on function public.portal_record_sign_out() to authenticated, service_role;

create or replace function app.recompute_attendance(p_id uuid)
returns void language plpgsql set search_path = public, app as $fn$
declare
  a public.attendance; s public.shifts; cfg public.attendance_settings; m public.memberships;
  v_worked int := 0; v_late int := 0; v_early int := 0; v_ot int := 0; v_status text;
  v_expected_start timestamptz; v_tz text;
begin
  select * into a from public.attendance where id = p_id;
  if not found then return; end if;
  select * into cfg from public.attendance_settings where id;
  select * into m from public.memberships where id = a.membership_id;
  select * into s from public.shifts
   where membership_id = a.membership_id and app.business_day(starts_at) = a.business_date
   order by starts_at limit 1;

  if a.clock_in is not null and a.clock_out is not null then
    v_worked := greatest(0, (extract(epoch from (a.clock_out - a.clock_in)) / 60)::int);
  end if;

  if s.id is not null then
    v_expected_start := s.starts_at;
  elsif m.shift_start_time is not null then
    -- No shift scheduled for this day — fall back to the member's own
    -- default start time (set at staff creation), interpreted in the
    -- restaurant's configured timezone, same zone app.business_day() uses.
    select timezone into v_tz from public.business_settings where id;
    v_expected_start := (a.business_date::timestamp + m.shift_start_time) at time zone coalesce(v_tz, 'UTC');
  end if;

  if v_expected_start is not null and a.clock_in is not null then
    v_late := greatest(0, (extract(epoch from (a.clock_in - v_expected_start)) / 60)::int - coalesce(cfg.grace_minutes, 0));
  end if;
  if s.id is not null and a.clock_out is not null then
    v_early := greatest(0, (extract(epoch from (s.ends_at - a.clock_out)) / 60)::int);
    if coalesce(cfg.overtime_enabled, false) then
      v_ot := greatest(0, (extract(epoch from (a.clock_out - s.ends_at)) / 60)::int);
    end if;
  end if;

  if a.status in ('absent', 'leave', 'off', 'half_day') then v_status := a.status;
  elsif a.clock_in is null then v_status := 'absent';
  elsif a.clock_out is null then v_status := 'incomplete';
  elsif v_late > 0 then v_status := 'late';
  elsif v_early > 0 then v_status := 'early_departure';
  else v_status := 'present';
  end if;

  update public.attendance
     set worked_minutes = v_worked, late_minutes = v_late, early_departure_minutes = v_early,
         overtime_minutes = v_ot, status = v_status, shift_id = s.id
   where id = p_id;
end $fn$;

-- attendance_roster() now also returns the effective expected start time
-- (an explicit shift for that day, else the member's default
-- shift_start_time) so the roster UI can show WHY someone is late/on time,
-- not just a bare "Xm late". New output columns change the function's
-- return type, which create-or-replace can't do — drop first.
drop function if exists public.attendance_roster(date);
create or replace function public.attendance_roster(p_date date default null)
returns table (membership_id uuid, full_name text, role text, status text,
               clock_in timestamptz, clock_out timestamptz, late_minutes int,
               shift_start_time time, expected_start timestamptz)
language plpgsql security definer set search_path = public, app as $fn$
declare v_date date := coalesce(p_date, app.business_day(now())); v_tz text;
begin
  if not (app.has_perm('attendance.view') or app.is_staff()) then
    raise exception 'forbidden' using errcode = 'insufficient_privilege';
  end if;
  select timezone into v_tz from public.business_settings where id;
  return query
    select m.id, m.full_name, m.role::text,
           coalesce(a.status, 'not_marked'), a.clock_in, a.clock_out, coalesce(a.late_minutes, 0),
           m.shift_start_time,
           coalesce(
             (select sh.starts_at from public.shifts sh
               where sh.membership_id = m.id and app.business_day(sh.starts_at) = v_date
               order by sh.starts_at limit 1),
             case when m.shift_start_time is not null
               then (v_date::timestamp + m.shift_start_time) at time zone coalesce(v_tz, 'UTC')
             end
           )
    from public.memberships m
    left join public.attendance a
      on a.membership_id = m.id and a.business_date = v_date
    where m.status = 'active'
    order by m.full_name nulls last;
end $fn$;
revoke all on function public.attendance_roster(date) from public;
grant execute on function public.attendance_roster(date) to authenticated, service_role;

-- ── Automatic absence marking ───────────────────────────────────────────
create or replace function public.attendance_auto_absent_sweep(p_lookback_days int default 3)
returns int language plpgsql security definer set search_path = public, app as $fn$
declare
  v_today date := app.business_day(now());
  v_marked int := 0;
  r record;
begin
  if not (app.jwt_role() = 'service_role' or app.has_perm('attendance.mark')) then
    raise exception 'forbidden' using errcode = 'insufficient_privilege';
  end if;

  for r in
    select m.id as membership_id, d.business_date
      from public.memberships m
      cross join lateral (
        select (v_today - g)::date as business_date
          from generate_series(1, greatest(p_lookback_days, 1)) as g
      ) d
     where m.status = 'active'
       and d.business_date < v_today
       and (
         -- Only ever auto-absent someone who was actually expected that
         -- day: an explicit shift, or a default shift_start_time on a day
         -- this restaurant normally schedules (attendance_settings.
         -- working_days) — never for someone never expected in.
         exists (
           select 1 from public.shifts sh
            where sh.membership_id = m.id and app.business_day(sh.starts_at) = d.business_date
         )
         or (
           m.shift_start_time is not null
           and extract(isodow from d.business_date)::int = any(
             select unnest(working_days) from public.attendance_settings where id
           )
         )
       )
       and not exists (
         select 1 from public.attendance a
          where a.membership_id = m.id and a.business_date = d.business_date
            and (a.clock_in is not null or a.status in ('absent', 'leave', 'off', 'half_day'))
       )
  loop
    insert into public.attendance (membership_id, business_date, status, source, marked_by)
    values (r.membership_id, r.business_date, 'absent', 'auto', null)
    on conflict (membership_id, business_date) do update
      set status = 'absent', source = 'auto'
      where public.attendance.clock_in is null
        and public.attendance.status not in ('leave', 'off', 'half_day');
    v_marked := v_marked + 1;
    perform app.log_action('attendance.auto_absent', 'attendance', r.membership_id::text, null,
      jsonb_build_object('business_date', r.business_date));
  end loop;

  return v_marked;
end $fn$;
revoke all on function public.attendance_auto_absent_sweep(int) from public;
grant execute on function public.attendance_auto_absent_sweep(int) to authenticated, service_role;
