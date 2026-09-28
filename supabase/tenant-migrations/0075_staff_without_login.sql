-- ============================================================================
-- 0075 — staff records without a login
--
-- Staff are now added with just a name, a job title typed by the owner
-- ("Waiter", "Tandoor chef", …) and an optional shift start. No email, no
-- password and no sign-in account: people reach their screens through
-- custom portals, and attendance/shifts point at the staff record.
--
--   * memberships.email is optional (still unique when given).
--   * memberships.job_title holds the free-text title shown everywhere.
--   * role 'staff' — a record with no login and no permissions of its own
--     (app.role_permissions('staff') is empty; there is no roles row).
-- ============================================================================

alter type app.member_role add value if not exists 'staff';

alter table public.memberships alter column email drop not null;
alter table public.memberships add column if not exists job_title text;
alter table public.memberships drop constraint if exists memberships_job_title_len;
alter table public.memberships add constraint memberships_job_title_len check (job_title is null or char_length(job_title) between 1 and 60);
