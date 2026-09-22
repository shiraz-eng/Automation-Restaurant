-- ============================================================================
-- Control-plane 0012 — site-assets storage bucket
--
-- Image uploads for the marketing-site CMS (0011). Same pattern tenant
-- projects already use for Brand Kit logos (tenant-template/schema.sql's
-- 'branding' bucket): public read (images are shown on the public site),
-- write gated to super_admin.
-- ============================================================================

insert into storage.buckets (id, name, public)
values ('site-assets', 'site-assets', true)
on conflict (id) do nothing;

create policy "site-assets public read" on storage.objects for select
  using (bucket_id = 'site-assets');
create policy "site-assets admin write" on storage.objects for all
  using (bucket_id = 'site-assets' and app.is_super_admin())
  with check (bucket_id = 'site-assets' and app.is_super_admin());
