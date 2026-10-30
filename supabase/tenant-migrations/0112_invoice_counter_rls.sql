-- ============================================================================
-- 0112 — Row Level Security on invoice_counter.
--
-- invoice_counter (0022) was the one tenant table without RLS, so with
-- Supabase's default grants anon and authenticated could read it or bump
-- next_number through the REST API, and a bumped counter makes the next
-- supplier invoice collide on invoice_ref. Like order_counter and po_counter,
-- it is only ever touched by its security-definer function
-- (next_invoice_ref()), which runs as the table owner and is not affected.
-- ============================================================================

alter table public.invoice_counter enable row level security; -- functions only
