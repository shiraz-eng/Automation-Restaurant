-- ============================================================================
-- Tenant delta 0045 — Receipt customization + expense→supplier linkage
-- ============================================================================

-- Receipt branding/format, configured once in Settings → Policies and used
-- by every printed/PDF receipt (Checkout, and the POS flow folded into it).
-- receipt_template_html is optional: null means "use the built-in layout";
-- when set, it's plain HTML with {{placeholder}} tokens the client
-- substitutes before printing — never executed/evaluated server-side, and
-- never trusted as anything but display markup for the owner's own print.
alter table public.business_settings
  add column if not exists receipt_logo_url text,
  add column if not exists receipt_footer_text text,
  add column if not exists receipt_template_html text;

-- Which supplier an expense was actually paid to — optional (most expense
-- categories, e.g. Rent/Utilities, have no supplier), but lets a
-- "Supplies"/"Ingredients" expense be tied to a real supplier record
-- instead of only free-text description.
alter table public.expenses
  add column if not exists supplier_id uuid references public.suppliers(id) on delete set null;

-- Logo upload storage, same pattern as menu-images (0019): public read (a
-- printed/PDF receipt is shown to the guest, so the logo must load without
-- auth), write gated to settings.update (Owner-only in practice, since
-- Policies is an ownerOnly page — see layout.tsx).
insert into storage.buckets (id, name, public)
values ('branding', 'branding', true)
on conflict (id) do nothing;

do $$ begin
  create policy "branding public read" on storage.objects for select
    using (bucket_id = 'branding');
exception when duplicate_object then null; end $$;
do $$ begin
  create policy "branding settings write" on storage.objects for all
    using (bucket_id = 'branding' and app.has_perm('settings.update'))
    with check (bucket_id = 'branding' and app.has_perm('settings.update'));
exception when duplicate_object then null; end $$;
