-- ============================================================================
-- 0080 — files attached to the AI Assistant chat
--
-- Chat attachments (PDFs, images, CSV/text) are uploaded to a private
-- 'ai-chat' bucket instead of riding inside the chat request (Vercel caps a
-- request at 4.5 MB). Each person can only upload and read files in their
-- own folder (<user id>/…), and only if they may use the assistant. The API
-- reads the file with the service role after checking the path belongs to
-- the caller. Files stay so follow-up questions about them keep working.
-- ============================================================================

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('ai-chat', 'ai-chat', false, 10485760,
        array['application/pdf', 'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'text/plain', 'text/csv'])
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "ai-chat own files" on storage.objects;
create policy "ai-chat own files" on storage.objects for all
  using (bucket_id = 'ai-chat' and app.has_perm('ai.view') and (storage.foldername(name))[1] = auth.uid()::text)
  with check (bucket_id = 'ai-chat' and app.has_perm('ai.view') and (storage.foldername(name))[1] = auth.uid()::text);
