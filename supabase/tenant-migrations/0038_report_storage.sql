-- 0038: Permanent report storage + per-section export domain tagging.
-- A generated PDF/Excel is still always COMPUTED fresh from live data each
-- time (never cached/served stale) — this just also saves the resulting
-- file to a private bucket so it can be re-downloaded later byte-for-byte
-- instead of regenerated. 'domain' lets a per-section export (Suppliers,
-- Purchasing, Inventory, Orders, Expenses) be distinguished from the full
-- multi-section report in the audit trail.

alter table public.export_audit_log add column if not exists domain text not null default 'complete';
alter table public.export_audit_log add column if not exists storage_path text;

insert into storage.buckets (id, name, public) values ('reports', 'reports', false) on conflict (id) do nothing;
drop policy if exists "reports staff read" on storage.objects;
create policy "reports staff read" on storage.objects for select
  using (bucket_id = 'reports' and (app.has_perm('reports.view') or app.has_perm('reports.export') or app.has_perm('reports.generate') or app.is_staff()));
drop policy if exists "reports staff write" on storage.objects;
create policy "reports staff write" on storage.objects for all
  using (bucket_id = 'reports' and (app.has_perm('reports.export') or app.has_perm('reports.generate') or app.can_write()))
  with check (bucket_id = 'reports' and (app.has_perm('reports.export') or app.has_perm('reports.generate') or app.can_write()));
