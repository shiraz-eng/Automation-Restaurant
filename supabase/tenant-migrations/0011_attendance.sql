-- ============================================================================
-- Tenant delta 0011 — P6: Attendance Portal
--
--   * business_settings (shared: timezone + business-day start + currency).
--   * attendance_settings (grace / working days / bands / overtime).
--   * attendance gains business_date, status, shift_id, late/early/worked/OT
--     minutes, source, portal_id, marked_by, created_at + one-row-per-day uniq.
--   * app.business_day(), app.my_membership_id(), app.recompute_attendance().
--   * RPCs: attendance_check_in / _check_out (dup + no-check-in guards),
--     attendance_mark, attendance_roster, attendance_month_summary.
--
-- Depends on 0006 (attendance.* keys) + 0010 (app.log_action). Idempotent.
-- ============================================================================

create table if not exists public.business_settings (
  id                        boolean primary key default true check (id),
  timezone                  text not null default 'UTC',
  business_day_start_minutes int not null default 0,
  currency_code             text not null default 'USD',
  week_start                int not null default 1
);
insert into public.business_settings (id) values (true) on conflict (id) do nothing;

create table if not exists public.attendance_settings (
  id                         boolean primary key default true check (id),
  grace_minutes              int not null default 10,
  standard_day_minutes       int not null default 480,
  working_days               int[] not null default '{1,2,3,4,5}',   -- ISO dow: 1=Mon..7=Sun
  overtime_enabled           boolean not null default false,
  overtime_requires_approval boolean not null default true,
  auto_checkout              text not null default 'none' check (auto_checkout in ('none','shift_end')),
  target_pct                 numeric(5,2),
  band_excellent             int not null default 90,
  band_good                  int not null default 80,
  band_attention             int not null default 70
);
insert into public.attendance_settings (id) values (true) on conflict (id) do nothing;

alter table public.attendance add column if not exists business_date            date;
alter table public.attendance add column if not exists status                   text
  check (status in ('present','late','absent','half_day','leave','off','early_departure','incomplete'));
alter table public.attendance add column if not exists shift_id                 uuid references public.shifts(id) on delete set null;
alter table public.attendance add column if not exists late_minutes             int not null default 0;
alter table public.attendance add column if not exists early_departure_minutes  int not null default 0;
alter table public.attendance add column if not exists worked_minutes           int not null default 0;
alter table public.attendance add column if not exists overtime_minutes         int not null default 0;
alter table public.attendance add column if not exists overtime_approved_minutes int not null default 0;
alter table public.attendance add column if not exists source                   text not null default 'self'
  check (source in ('self','device','manager','auto'));
alter table public.attendance add column if not exists portal_id                uuid;
alter table public.attendance add column if not exists marked_by               uuid;
alter table public.attendance add column if not exists created_at              timestamptz not null default now();

-- ── Helpers ───────────────────────────────────────────────────────────────
create or replace function app.business_day(p_ts timestamptz default now())
returns date language sql stable set search_path = public, app as $$
  select ((p_ts at time zone (select timezone from public.business_settings where id))
          - make_interval(mins => (select business_day_start_minutes from public.business_settings where id)))::date
$$;

create or replace function app.my_membership_id() returns uuid
language sql stable security definer set search_path = public, app as $$
  select id from public.memberships where user_id = app.jwt_sub()
$$;

update public.attendance set business_date = app.business_day(clock_in)
 where business_date is null and clock_in is not null;

-- one row per member per business day: drop stray duplicates (keeps the newest)
delete from public.attendance a
using public.attendance b
where a.membership_id = b.membership_id
  and a.business_date is not null
  and a.business_date = b.business_date
  and a.ctid < b.ctid;

create unique index if not exists attendance_member_date_uq
  on public.attendance(membership_id, business_date);

create or replace function app.recompute_attendance(p_id uuid)
returns void language plpgsql set search_path = public, app as $$
declare
  a public.attendance; s public.shifts; cfg public.attendance_settings;
  v_worked int := 0; v_late int := 0; v_early int := 0; v_ot int := 0; v_status text;
begin
  select * into a from public.attendance where id = p_id;
  if not found then return; end if;
  select * into cfg from public.attendance_settings where id;
  select * into s from public.shifts
   where membership_id = a.membership_id and app.business_day(starts_at) = a.business_date
   order by starts_at limit 1;

  if a.clock_in is not null and a.clock_out is not null then
    v_worked := greatest(0, (extract(epoch from (a.clock_out - a.clock_in)) / 60)::int);
  end if;

  if s.id is not null then
    if a.clock_in is not null then
      v_late := greatest(0, (extract(epoch from (a.clock_in - s.starts_at)) / 60)::int - coalesce(cfg.grace_minutes, 0));
    end if;
    if a.clock_out is not null then
      v_early := greatest(0, (extract(epoch from (s.ends_at - a.clock_out)) / 60)::int);
      if coalesce(cfg.overtime_enabled, false) then
        v_ot := greatest(0, (extract(epoch from (a.clock_out - s.ends_at)) / 60)::int);
      end if;
    end if;
  end if;

  if a.status in ('absent', 'leave', 'off', 'half_day') then
    v_status := a.status;
  elsif a.clock_in is null then
    v_status := 'absent';
  elsif a.clock_out is null then
    v_status := 'incomplete';
  elsif v_late > 0 then
    v_status := 'late';
  elsif v_early > 0 then
    v_status := 'early_departure';
  else
    v_status := 'present';
  end if;

  update public.attendance
     set worked_minutes = v_worked, late_minutes = v_late, early_departure_minutes = v_early,
         overtime_minutes = v_ot, status = v_status, shift_id = s.id
   where id = p_id;
end $$;

-- ── Check in / out / mark ────────────────────────────────────────────────
create or replace function public.attendance_check_in(p_membership_id uuid default null)
returns public.attendance
language plpgsql security definer set search_path = public, app as $$
declare v_mid uuid; v_date date := app.business_day(now()); v_row public.attendance; v_self boolean;
begin
  v_mid := coalesce(p_membership_id, app.my_membership_id());
  if v_mid is null then raise exception 'no_membership' using errcode = 'no_data_found'; end if;
  v_self := (v_mid = app.my_membership_id());
  if not (app.has_perm('attendance.check_in') or (v_self and app.has_perm('attendance.view_own'))) then
    raise exception 'forbidden' using errcode = 'insufficient_privilege';
  end if;

  select * into v_row from public.attendance where membership_id = v_mid and business_date = v_date;
  if found and v_row.clock_in is not null and v_row.clock_out is null then
    raise exception 'already_checked_in' using errcode = 'unique_violation';
  end if;

  if found then
    update public.attendance
       set clock_in = coalesce(clock_in, now()),
           source = case when app.current_portal_id() is not null then 'device' else 'self' end,
           portal_id = app.current_portal_id(), marked_by = app.jwt_sub()
     where id = v_row.id returning * into v_row;
  else
    insert into public.attendance (membership_id, business_date, clock_in, source, portal_id, marked_by, status)
    values (v_mid, v_date, now(),
            case when app.current_portal_id() is not null then 'device' else 'self' end,
            app.current_portal_id(), app.jwt_sub(), 'present')
    returning * into v_row;
  end if;

  perform app.recompute_attendance(v_row.id);
  perform app.log_action('attendance.check_in', 'attendance', v_row.id::text);
  select * into v_row from public.attendance where id = v_row.id;
  return v_row;
end $$;
revoke all on function public.attendance_check_in(uuid) from public;
grant execute on function public.attendance_check_in(uuid) to authenticated, service_role;

create or replace function public.attendance_check_out(p_membership_id uuid default null)
returns public.attendance
language plpgsql security definer set search_path = public, app as $$
declare v_mid uuid; v_date date := app.business_day(now()); v_row public.attendance; v_self boolean;
begin
  v_mid := coalesce(p_membership_id, app.my_membership_id());
  if v_mid is null then raise exception 'no_membership' using errcode = 'no_data_found'; end if;
  v_self := (v_mid = app.my_membership_id());
  if not (app.has_perm('attendance.check_out') or (v_self and app.has_perm('attendance.view_own'))) then
    raise exception 'forbidden' using errcode = 'insufficient_privilege';
  end if;

  select * into v_row from public.attendance where membership_id = v_mid and business_date = v_date;
  if not found or v_row.clock_in is null then
    raise exception 'not_checked_in' using errcode = 'check_violation';
  end if;
  update public.attendance set clock_out = now() where id = v_row.id returning * into v_row;
  perform app.recompute_attendance(v_row.id);
  perform app.log_action('attendance.check_out', 'attendance', v_row.id::text);
  select * into v_row from public.attendance where id = v_row.id;
  return v_row;
end $$;
revoke all on function public.attendance_check_out(uuid) from public;
grant execute on function public.attendance_check_out(uuid) to authenticated, service_role;

create or replace function public.attendance_mark(
  p_membership_id uuid, p_business_date date, p_status text, p_note text default null
) returns void language plpgsql security definer set search_path = public, app as $$
begin
  if not app.has_perm('attendance.mark') then
    raise exception 'forbidden' using errcode = 'insufficient_privilege';
  end if;
  if p_status not in ('present','absent','late','half_day','leave','off','early_departure') then
    raise exception 'bad_status' using errcode = 'check_violation';
  end if;
  insert into public.attendance (membership_id, business_date, status, note, source, marked_by, portal_id)
  values (p_membership_id, p_business_date, p_status, p_note, 'manager', app.jwt_sub(), app.current_portal_id())
  on conflict (membership_id, business_date) do update
    set status = excluded.status,
        note = coalesce(excluded.note, public.attendance.note),
        source = 'manager', marked_by = excluded.marked_by;
  perform app.log_action('attendance.mark', 'attendance', p_membership_id::text, null,
                         jsonb_build_object('date', p_business_date, 'status', p_status));
end $$;
revoke all on function public.attendance_mark(uuid, date, text, text) from public;
grant execute on function public.attendance_mark(uuid, date, text, text) to authenticated, service_role;

-- ── Read: roster + monthly summary ──────────────────────────────────────
create or replace function public.attendance_roster(p_date date default null)
returns table (membership_id uuid, full_name text, role text, status text,
               clock_in timestamptz, clock_out timestamptz, late_minutes int)
language plpgsql security definer set search_path = public, app as $$
begin
  if not (app.has_perm('attendance.view') or app.is_staff()) then
    raise exception 'forbidden' using errcode = 'insufficient_privilege';
  end if;
  return query
    select m.id, m.full_name, m.role::text,
           coalesce(a.status, 'not_marked'), a.clock_in, a.clock_out, coalesce(a.late_minutes, 0)
    from public.memberships m
    left join public.attendance a
      on a.membership_id = m.id and a.business_date = coalesce(p_date, app.business_day(now()))
    where m.status = 'active'
    order by m.full_name nulls last;
end $$;
revoke all on function public.attendance_roster(date) from public;
grant execute on function public.attendance_roster(date) to authenticated, service_role;

create or replace function public.attendance_month_summary(
  p_membership_id uuid, p_year int, p_month int
) returns jsonb language plpgsql security definer set search_path = public, app as $$
declare
  v_self boolean := (p_membership_id = app.my_membership_id());
  cfg public.attendance_settings;
  v_from date := make_date(p_year, p_month, 1);
  v_to date := (make_date(p_year, p_month, 1) + interval '1 month')::date;
  v_scheduled int; v_present int; v_absent int; v_late int; v_leave int;
  v_worked int; v_ot int;
begin
  if not (app.has_perm('attendance.view_reports') or app.has_perm('attendance.view_employee_reports')
          or (v_self and app.has_perm('attendance.view_own'))) then
    raise exception 'forbidden' using errcode = 'insufficient_privilege';
  end if;
  select * into cfg from public.attendance_settings where id;

  select count(*) into v_scheduled
  from generate_series(v_from, v_to - 1, interval '1 day') d
  where extract(isodow from d)::int = any(cfg.working_days);

  select
    count(*) filter (where status in ('present','late','early_departure','half_day')),
    count(*) filter (where status = 'absent'),
    count(*) filter (where status = 'late'),
    count(*) filter (where status = 'leave'),
    coalesce(sum(worked_minutes), 0),
    coalesce(sum(overtime_approved_minutes), 0)
  into v_present, v_absent, v_late, v_leave, v_worked, v_ot
  from public.attendance
  where membership_id = p_membership_id and business_date >= v_from and business_date < v_to;

  return jsonb_build_object(
    'scheduled_days', v_scheduled,
    'present', v_present, 'absent', v_absent, 'late', v_late, 'leave', v_leave,
    'worked_minutes', v_worked, 'approved_overtime_minutes', v_ot,
    'attendance_pct', case when v_scheduled - v_leave > 0
      then round(v_present::numeric * 100 / (v_scheduled - v_leave), 1) end,
    'punctuality_pct', case when v_present > 0
      then round((v_present - v_late)::numeric * 100 / v_present, 1) end,
    'bands', jsonb_build_object('excellent', cfg.band_excellent, 'good', cfg.band_good,
                                'attention', cfg.band_attention)
  );
end $$;
revoke all on function public.attendance_month_summary(uuid, int, int) from public;
grant execute on function public.attendance_month_summary(uuid, int, int) to authenticated, service_role;

-- ── RLS + audit ────────────────────────────────────────────────────────
alter table public.business_settings enable row level security;
alter table public.attendance_settings enable row level security;
drop policy if exists staff_read on public.business_settings;
drop policy if exists mgr_write on public.business_settings;
drop policy if exists staff_read on public.attendance_settings;
drop policy if exists mgr_write on public.attendance_settings;
create policy staff_read on public.business_settings for select using (app.has_perm('settings.view') or app.is_staff());
create policy mgr_write on public.business_settings for all using (app.has_perm('settings.update') or app.can_write()) with check (app.has_perm('settings.update') or app.can_write());
create policy staff_read on public.attendance_settings for select using (app.has_perm('settings.view') or app.is_staff());
create policy mgr_write on public.attendance_settings for all using (app.has_perm('settings.update') or app.can_write()) with check (app.has_perm('settings.update') or app.can_write());

-- attendance: add an own-record read path for attendance.view_own holders
drop policy if exists staff_read on public.attendance;
create policy staff_read on public.attendance for select using (
  app.has_perm('attendance.view') or app.is_staff() or membership_id = app.my_membership_id()
);

do $$
declare tbl text;
begin
  foreach tbl in array array['attendance','business_settings','attendance_settings'] loop
    execute format('drop trigger if exists audit on public.%I;', tbl);
    execute format('create trigger audit after insert or update or delete on public.%I for each row execute function app.audit_row();', tbl);
  end loop;
end $$;
