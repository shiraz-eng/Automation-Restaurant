-- 0039: export_audit_log gets an update policy. PDF generation happens
-- client-side (jsPDF) — the audit row is written server-side the moment
-- the report DATA is built (0037), before the PDF bytes exist; once the
-- browser actually renders the file and uploads it to the 'reports'
-- bucket, it patches that same row with storage_path. Excel doesn't need
-- this — it's generated server-side in one request, so its row is
-- inserted complete with storage_path already known.

drop policy if exists staff_update on public.export_audit_log;
create policy staff_update on public.export_audit_log for update
  using (app.has_perm('reports.generate') or app.has_perm('reports.export') or app.can_write())
  with check (app.has_perm('reports.generate') or app.has_perm('reports.export') or app.can_write());
