-- 0037: Export audit trail (Restaurant Performance & Owner Activity
-- Intelligence, spec §39). One row per generated PDF/Excel report, written
-- by the API right after a report/export actually succeeds (or fails) —
-- never backfilled or inferred. Records exports only, not the report
-- CONTENT itself (nothing is stored server-side; every report is
-- generated fresh from the same authoritative data each time).

create table if not exists public.export_audit_log (
  id                 uuid primary key default gen_random_uuid(),
  format             text not null check (format in ('pdf', 'excel')),
  period_label       text not null,
  period_from        timestamptz not null,
  period_to          timestamptz not null,
  -- Only meaningful for an 'excel' export narrowed by the Custom Export
  -- sheet picker (spec §37) — null means the full workbook.
  sheets             text[],
  requested_by       uuid,
  requested_by_email text,
  requested_by_role  text,
  status             text not null default 'ready' check (status in ('ready', 'failed')),
  error              text,
  created_at         timestamptz not null default now()
);
create index if not exists export_audit_log_created_idx on public.export_audit_log(created_at desc);

alter table public.export_audit_log enable row level security;
drop policy if exists staff_read on public.export_audit_log;
create policy staff_read on public.export_audit_log for select
  using (app.has_perm('reports.view') or app.has_perm('reports.export') or app.has_perm('reports.generate') or app.is_staff());
drop policy if exists staff_insert on public.export_audit_log;
create policy staff_insert on public.export_audit_log for insert
  with check (app.has_perm('reports.generate') or app.has_perm('reports.export') or app.can_write());
