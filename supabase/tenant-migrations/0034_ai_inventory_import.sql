-- 0034: AI Inventory Import. The same document-to-draft pattern as AI Menu
-- Import (migration 0031), proven a second time on a different domain:
-- file (PDF or CSV text) -> LLM structuring -> validation -> diff against
-- LIVE inventory_items -> owner review -> selective apply. Applying writes
-- to the SAME inventory_items table the manual Inventory page uses. Uses
-- the generically-named 'ai-imports' bucket rather than 'menu-imports',
-- since this is the first of presumably several non-menu import domains.

do $$ begin
  if not exists (select 1 from pg_type where typname = 'inventory_import_status' and typnamespace = 'app'::regnamespace) then
    create type app.inventory_import_status as enum ('draft', 'ready_for_review', 'applied', 'rejected', 'failed');
  end if;
end $$;

create table if not exists public.inventory_import_drafts (
  id              uuid primary key default gen_random_uuid(),
  source_filename text not null,
  storage_path    text not null,
  extracted_json  jsonb not null,
  diff_json       jsonb not null,
  status          app.inventory_import_status not null default 'ready_for_review',
  error           text,
  created_by      uuid,
  created_at      timestamptz not null default now(),
  applied_at      timestamptz,
  applied_by      uuid
);
alter table public.inventory_import_drafts enable row level security;
drop policy if exists staff_read on public.inventory_import_drafts;
create policy staff_read on public.inventory_import_drafts for select using (app.has_perm('stock.view') or app.is_staff());
drop policy if exists mgr_write on public.inventory_import_drafts;
create policy mgr_write on public.inventory_import_drafts for all
  using (app.has_perm('stock.update') or app.can_write())
  with check (app.has_perm('stock.update') or app.can_write());

insert into storage.buckets (id, name, public)
values ('ai-imports', 'ai-imports', false)
on conflict (id) do nothing;
drop policy if exists "ai-imports staff read" on storage.objects;
create policy "ai-imports staff read" on storage.objects for select
  using (bucket_id = 'ai-imports' and (app.has_perm('stock.view') or app.is_staff()));
drop policy if exists "ai-imports staff write" on storage.objects;
create policy "ai-imports staff write" on storage.objects for all
  using (bucket_id = 'ai-imports' and (app.has_perm('stock.update') or app.can_write()))
  with check (bucket_id = 'ai-imports' and (app.has_perm('stock.update') or app.can_write()));
