-- ============================================================================
-- 0026 — Details the owner gives when creating a branch, held until it is ready.
--
-- A branch's database takes a few minutes to set up, so what the owner enters in
-- "Add a branch" — today the branch's own receipt details (address, phone, email,
-- website, tax number, footer) — waits here and is written into the branch's own
-- database right after the menu copy, then cleared.
--
--   tenants.branch_setup   { "receipt": { "address": "...", "phone": "...", ... } } | null
--
-- Holds no secrets: passwords are never stored here.
-- ============================================================================

alter table public.tenants add column if not exists branch_setup jsonb;

comment on column public.tenants.branch_setup is
  'Pending setup for a branch still being created (e.g. its receipt details); applied once it is active, then cleared.';
