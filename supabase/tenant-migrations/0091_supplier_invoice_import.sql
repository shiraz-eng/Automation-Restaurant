-- ============================================================================
-- 0091_supplier_invoice_import.sql — Finance Phase E (AI invoice reading)
-- Drafts produced when the AI reads a supplier's invoice (PDF, scan, photo
-- or text). A draft is only a proposal: a person reviews and corrects it,
-- and creating the invoice from it is a separate step that lands the
-- invoice as 'received' — it still has to pass the 3-way match and approval.
-- The API writes drafts with the service role; the app may only read them.
-- ============================================================================
create table if not exists public.supplier_invoice_import_drafts (
  id              uuid primary key default gen_random_uuid(),
  source_filename text not null,
  storage_path    text not null,
  extracted_json  jsonb not null,
  draft_json      jsonb not null,
  status          text not null default 'ready_for_review'
                    check (status in ('ready_for_review', 'applied', 'rejected', 'failed')),
  error           text,
  invoice_id      uuid references public.supplier_invoices(id) on delete set null,
  created_by      uuid,
  created_at      timestamptz not null default now(),
  applied_at      timestamptz,
  applied_by      uuid
);
create index if not exists supplier_invoice_import_drafts_created_idx
  on public.supplier_invoice_import_drafts (created_at desc);

alter table public.supplier_invoice_import_drafts enable row level security;
drop policy if exists staff_read on public.supplier_invoice_import_drafts;
create policy staff_read on public.supplier_invoice_import_drafts for select using (
  app.has_perm('invoices.create') or app.has_perm('invoices.view') or app.can_write());
revoke insert, update, delete on public.supplier_invoice_import_drafts from anon, authenticated;
