-- ============================================================================
-- Tenant delta 0048 — Configurable receipt template
--
-- Extends business_settings (already the tenant's singleton settings row,
-- already used for receipt_footer_text/receipt_template_html since 0045
-- and the Brand Kit since 0046) with:
--   1. A handful of restaurant contact fields the "Restaurant Information"
--      receipt section needs and that nothing in this schema stores yet
--      (address/phone/contact email/website/tax registration number).
--   2. receipt_config jsonb — the structured, section-based receipt
--      template (which sections appear, in what order, which fields
--      within each, custom text blocks, thermal width/divider style).
--      A single JSONB column rather than a wide table because the shape
--      is inherently a tree the Owner edits as one unit and the renderer
--      reads as one unit — there is no query pattern that needs it
--      normalized, matching how `permissions text[]` already lives as
--      one column on public.portals for the same reason.
-- Null receipt_config means "this restaurant has never configured a
-- receipt" — the renderer falls back to the existing built-in layout
-- (receipt_footer_text/receipt_template_html), unchanged.
-- ============================================================================

alter table public.business_settings
  add column if not exists address                    text,
  add column if not exists phone                       text,
  add column if not exists contact_email               text,
  add column if not exists website                     text,
  add column if not exists tax_registration_number      text,
  add column if not exists receipt_config               jsonb;
