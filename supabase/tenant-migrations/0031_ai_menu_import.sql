-- 0031: AI menu import. A document-derived menu draft: file (PDF text
-- today) -> LLM structuring -> validation -> diff against the LIVE menu ->
-- owner review -> selective apply. Applying writes to the SAME
-- menu_categories/menu_items/menu_variants/modifier_groups/modifier_options
-- tables the manual Menu page uses — there is no AI-only menu store.

do $$ begin
  if not exists (select 1 from pg_type where typname = 'menu_import_status' and typnamespace = 'app'::regnamespace) then
    create type app.menu_import_status as enum ('draft', 'ready_for_review', 'applied', 'rejected', 'failed');
  end if;
end $$;

create table if not exists public.menu_import_drafts (
  id              uuid primary key default gen_random_uuid(),
  source_filename text not null,
  storage_path    text not null,
  extracted_json  jsonb not null,
  diff_json       jsonb not null,
  status          app.menu_import_status not null default 'ready_for_review',
  error           text,
  created_by      uuid,
  created_at      timestamptz not null default now(),
  applied_at      timestamptz,
  applied_by      uuid
);
alter table public.menu_import_drafts enable row level security;
drop policy if exists staff_read on public.menu_import_drafts;
create policy staff_read on public.menu_import_drafts for select using (app.has_perm('menu.view') or app.is_staff());
drop policy if exists mgr_write on public.menu_import_drafts;
create policy mgr_write on public.menu_import_drafts for all
  using (app.has_perm('menu.create') or app.has_perm('menu.update') or app.can_write())
  with check (app.has_perm('menu.create') or app.has_perm('menu.update') or app.can_write());

insert into storage.buckets (id, name, public)
values ('menu-imports', 'menu-imports', false)
on conflict (id) do nothing;
drop policy if exists "menu-imports staff read" on storage.objects;
create policy "menu-imports staff read" on storage.objects for select
  using (bucket_id = 'menu-imports' and (app.has_perm('menu.view') or app.is_staff()));
drop policy if exists "menu-imports staff write" on storage.objects;
create policy "menu-imports staff write" on storage.objects for all
  using (bucket_id = 'menu-imports' and (app.has_perm('menu.create') or app.has_perm('menu.update') or app.can_write()))
  with check (bucket_id = 'menu-imports' and (app.has_perm('menu.create') or app.has_perm('menu.update') or app.can_write()));
