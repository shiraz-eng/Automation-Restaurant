-- 0036: three more domains on the shared AI document-import engine —
-- supplier price import, purchase order import, staff import — plus
-- broadening the shared 'ai-imports' bucket's RLS once more.

drop policy if exists "ai-imports staff read" on storage.objects;
create policy "ai-imports staff read" on storage.objects for select
  using (bucket_id = 'ai-imports' and (
    app.has_perm('stock.view') or app.has_perm('menu.view') or
    app.has_perm('supplier.view') or app.has_perm('tables.view') or
    app.has_perm('purchases.view') or app.has_perm('staff.view') or
    app.is_staff()
  ));
drop policy if exists "ai-imports staff write" on storage.objects;
create policy "ai-imports staff write" on storage.objects for all
  using (bucket_id = 'ai-imports' and (
    app.has_perm('stock.update') or app.has_perm('inventory.manage_recipes') or
    app.has_perm('finance.manage_recipes') or app.has_perm('tables.update') or
    app.has_perm('supplier.manage') or app.has_perm('purchases.update') or
    app.has_perm('staff.create') or app.can_write()
  ))
  with check (bucket_id = 'ai-imports' and (
    app.has_perm('stock.update') or app.has_perm('inventory.manage_recipes') or
    app.has_perm('finance.manage_recipes') or app.has_perm('tables.update') or
    app.has_perm('supplier.manage') or app.has_perm('purchases.update') or
    app.has_perm('staff.create') or app.can_write()
  ));

-- AI Supplier Price Import. Price CHANGES on an existing catalog entry go
-- through set_supplier_item_price() at apply time (logged to
-- supplier_price_history like every other price change); a brand new
-- (supplier, item) pairing is a plain insert, matching the manual
-- Inventory page's own supplier_items insert.
do $$ begin
  if not exists (select 1 from pg_type where typname = 'supplier_price_import_status' and typnamespace = 'app'::regnamespace) then
    create type app.supplier_price_import_status as enum ('draft', 'ready_for_review', 'applied', 'rejected', 'failed');
  end if;
end $$;
create table if not exists public.supplier_price_import_drafts (
  id              uuid primary key default gen_random_uuid(),
  source_filename text not null,
  storage_path    text not null,
  extracted_json  jsonb not null,
  diff_json       jsonb not null,
  status          app.supplier_price_import_status not null default 'ready_for_review',
  error           text,
  created_by      uuid,
  created_at      timestamptz not null default now(),
  applied_at      timestamptz,
  applied_by      uuid
);
alter table public.supplier_price_import_drafts enable row level security;
drop policy if exists staff_read on public.supplier_price_import_drafts;
create policy staff_read on public.supplier_price_import_drafts for select using (app.has_perm('supplier.view') or app.is_staff());
drop policy if exists mgr_write on public.supplier_price_import_drafts;
create policy mgr_write on public.supplier_price_import_drafts for all
  using (app.has_perm('supplier.manage') or app.can_write())
  with check (app.has_perm('supplier.manage') or app.can_write());

-- AI Purchase Order Import. Creates each order ONLY with prices already
-- on file in that supplier's own catalog (never invented) — if any line
-- in an order doesn't resolve, the WHOLE order is blocked, matching the
-- AI chat's draft_purchase_order rule. Every created order lands as a
-- 'draft' (purchase_orders.status default); approving/sending stays a
-- separate, human-only step in Purchasing.
do $$ begin
  if not exists (select 1 from pg_type where typname = 'po_import_status' and typnamespace = 'app'::regnamespace) then
    create type app.po_import_status as enum ('draft', 'ready_for_review', 'applied', 'rejected', 'failed');
  end if;
end $$;
create table if not exists public.po_import_drafts (
  id              uuid primary key default gen_random_uuid(),
  source_filename text not null,
  storage_path    text not null,
  extracted_json  jsonb not null,
  diff_json       jsonb not null,
  status          app.po_import_status not null default 'ready_for_review',
  error           text,
  created_by      uuid,
  created_at      timestamptz not null default now(),
  applied_at      timestamptz,
  applied_by      uuid
);
alter table public.po_import_drafts enable row level security;
drop policy if exists staff_read on public.po_import_drafts;
create policy staff_read on public.po_import_drafts for select using (app.has_perm('purchases.view') or app.is_staff());
drop policy if exists mgr_write on public.po_import_drafts;
create policy mgr_write on public.po_import_drafts for all
  using (app.has_perm('purchases.update') or app.can_write())
  with check (app.has_perm('purchases.update') or app.can_write());

-- AI Staff Import. The one import domain that creates real login
-- credentials, so it carries its own extra safeguards (see
-- apps/api/src/lib/staffImport.ts): exact role matching against the same
-- fixed creatable-role list POST /api/staff enforces (never 'owner'), and
-- an anti-escalation check identical to POST /api/staff/access — a row
-- whose role exceeds the approving user's OWN permissions is blocked, not
-- silently capped. An existing account (matched by email) is left alone.
do $$ begin
  if not exists (select 1 from pg_type where typname = 'staff_import_status' and typnamespace = 'app'::regnamespace) then
    create type app.staff_import_status as enum ('draft', 'ready_for_review', 'applied', 'rejected', 'failed');
  end if;
end $$;
create table if not exists public.staff_import_drafts (
  id              uuid primary key default gen_random_uuid(),
  source_filename text not null,
  storage_path    text not null,
  extracted_json  jsonb not null,
  diff_json       jsonb not null,
  status          app.staff_import_status not null default 'ready_for_review',
  error           text,
  created_by      uuid,
  created_at      timestamptz not null default now(),
  applied_at      timestamptz,
  applied_by      uuid
);
alter table public.staff_import_drafts enable row level security;
drop policy if exists staff_read on public.staff_import_drafts;
create policy staff_read on public.staff_import_drafts for select using (app.has_perm('staff.view') or app.is_staff());
drop policy if exists mgr_write on public.staff_import_drafts;
create policy mgr_write on public.staff_import_drafts for all
  using (app.has_perm('staff.create') or app.can_write())
  with check (app.has_perm('staff.create') or app.can_write());
