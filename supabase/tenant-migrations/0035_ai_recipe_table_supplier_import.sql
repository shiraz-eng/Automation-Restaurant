-- 0035: three more domains on the shared AI document-import engine —
-- recipe import, table import, supplier import — plus broadening the
-- generic 'ai-imports' bucket's RLS so each of them (not just inventory
-- import) can actually use it.

-- Broaden ai-imports bucket policies to the new domains' permissions too.
drop policy if exists "ai-imports staff read" on storage.objects;
create policy "ai-imports staff read" on storage.objects for select
  using (bucket_id = 'ai-imports' and (
    app.has_perm('stock.view') or app.has_perm('menu.view') or
    app.has_perm('supplier.view') or app.has_perm('tables.view') or
    app.is_staff()
  ));
drop policy if exists "ai-imports staff write" on storage.objects;
create policy "ai-imports staff write" on storage.objects for all
  using (bucket_id = 'ai-imports' and (
    app.has_perm('stock.update') or app.has_perm('inventory.manage_recipes') or
    app.has_perm('finance.manage_recipes') or app.has_perm('tables.update') or
    app.has_perm('supplier.manage') or app.can_write()
  ))
  with check (bucket_id = 'ai-imports' and (
    app.has_perm('stock.update') or app.has_perm('inventory.manage_recipes') or
    app.has_perm('finance.manage_recipes') or app.has_perm('tables.update') or
    app.has_perm('supplier.manage') or app.can_write()
  ));

-- AI Recipe Import. Creates recipes ONLY through create_recipe() (never a
-- raw table insert) — always lands as a draft, exactly like the manual
-- Recipes page and the AI chat's draft_recipe action. Never edits an
-- existing recipe.
do $$ begin
  if not exists (select 1 from pg_type where typname = 'recipe_import_status' and typnamespace = 'app'::regnamespace) then
    create type app.recipe_import_status as enum ('draft', 'ready_for_review', 'applied', 'rejected', 'failed');
  end if;
end $$;
create table if not exists public.recipe_import_drafts (
  id              uuid primary key default gen_random_uuid(),
  source_filename text not null,
  storage_path    text not null,
  extracted_json  jsonb not null,
  diff_json       jsonb not null,
  status          app.recipe_import_status not null default 'ready_for_review',
  error           text,
  created_by      uuid,
  created_at      timestamptz not null default now(),
  applied_at      timestamptz,
  applied_by      uuid
);
alter table public.recipe_import_drafts enable row level security;
drop policy if exists staff_read on public.recipe_import_drafts;
create policy staff_read on public.recipe_import_drafts for select
  using (app.has_perm('inventory.manage_recipes') or app.has_perm('finance.manage_recipes') or app.is_staff());
drop policy if exists mgr_write on public.recipe_import_drafts;
create policy mgr_write on public.recipe_import_drafts for all
  using (app.has_perm('inventory.manage_recipes') or app.has_perm('finance.manage_recipes') or app.can_write())
  with check (app.has_perm('inventory.manage_recipes') or app.has_perm('finance.manage_recipes') or app.can_write());

-- AI Table Import. Create-only — an existing table label is left alone.
do $$ begin
  if not exists (select 1 from pg_type where typname = 'table_import_status' and typnamespace = 'app'::regnamespace) then
    create type app.table_import_status as enum ('draft', 'ready_for_review', 'applied', 'rejected', 'failed');
  end if;
end $$;
create table if not exists public.table_import_drafts (
  id              uuid primary key default gen_random_uuid(),
  source_filename text not null,
  storage_path    text not null,
  extracted_json  jsonb not null,
  diff_json       jsonb not null,
  status          app.table_import_status not null default 'ready_for_review',
  error           text,
  created_by      uuid,
  created_at      timestamptz not null default now(),
  applied_at      timestamptz,
  applied_by      uuid
);
alter table public.table_import_drafts enable row level security;
drop policy if exists staff_read on public.table_import_drafts;
create policy staff_read on public.table_import_drafts for select using (app.has_perm('tables.view') or app.is_staff());
drop policy if exists mgr_write on public.table_import_drafts;
create policy mgr_write on public.table_import_drafts for all
  using (app.has_perm('tables.update') or app.can_write())
  with check (app.has_perm('tables.update') or app.can_write());

-- AI Supplier Import. Create-only — contact/payment details on an
-- existing supplier are never silently overwritten from a document.
do $$ begin
  if not exists (select 1 from pg_type where typname = 'supplier_import_status' and typnamespace = 'app'::regnamespace) then
    create type app.supplier_import_status as enum ('draft', 'ready_for_review', 'applied', 'rejected', 'failed');
  end if;
end $$;
create table if not exists public.supplier_import_drafts (
  id              uuid primary key default gen_random_uuid(),
  source_filename text not null,
  storage_path    text not null,
  extracted_json  jsonb not null,
  diff_json       jsonb not null,
  status          app.supplier_import_status not null default 'ready_for_review',
  error           text,
  created_by      uuid,
  created_at      timestamptz not null default now(),
  applied_at      timestamptz,
  applied_by      uuid
);
alter table public.supplier_import_drafts enable row level security;
drop policy if exists staff_read on public.supplier_import_drafts;
create policy staff_read on public.supplier_import_drafts for select using (app.has_perm('supplier.view') or app.is_staff());
drop policy if exists mgr_write on public.supplier_import_drafts;
create policy mgr_write on public.supplier_import_drafts for all
  using (app.has_perm('supplier.manage') or app.can_write())
  with check (app.has_perm('supplier.manage') or app.can_write());
