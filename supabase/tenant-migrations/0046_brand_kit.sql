-- ============================================================================
-- Tenant delta 0046 — Restaurant Brand Kit
--
-- Extends business_settings (already the tenant's one settings singleton,
-- already used for receipt customization in 0045) with the restaurant's
-- visual identity, reusing the SAME CSS-variable token names the existing
-- theme system (apps/web/src/lib/theme.ts, globals.css, tailwind.config.ts)
-- already defines — no second theming system, just moving that system's
-- persistence from per-browser localStorage to this per-tenant table.
-- ============================================================================

-- receipt_logo_url becomes the restaurant's one general-purpose logo (also
-- used on receipts/PDFs specifically) — renamed rather than duplicated, per
-- "do not duplicate fields that already exist elsewhere".
alter table public.business_settings rename column receipt_logo_url to brand_logo_url;

alter table public.business_settings
  add column if not exists brand_primary      text, -- "R G B" channel string, matches theme.ts's ThemeTokens shape
  add column if not exists brand_primary_fg    text,
  add column if not exists brand_bg_main       text,
  add column if not exists brand_bg_surface    text,
  add column if not exists brand_border        text,
  add column if not exists brand_text_body     text,
  add column if not exists brand_text_muted    text,
  add column if not exists brand_radius        text, -- e.g. "12px"
  add column if not exists brand_appearance    text check (brand_appearance in ('light', 'dark', 'system'));

-- Narrow, anon-safe read of ONLY the visual-identity columns — business_
-- settings as a whole (refund policy, receipt footer/template text) stays
-- staff-only; a guest-facing storefront/AI needs just enough to render the
-- restaurant's own look, nothing else. SECURITY DEFINER + a fixed column
-- list (not "select *") is what keeps this narrow regardless of what else
-- business_settings grows later.
create or replace function public.get_brand_kit()
returns table(
  logo_url text, primary_color text, primary_fg text,
  bg_main text, bg_surface text, border_color text,
  text_body text, text_muted text, radius text, appearance text
)
language sql stable security definer set search_path = public as $$
  select brand_logo_url, brand_primary, brand_primary_fg,
         brand_bg_main, brand_bg_surface, brand_border,
         brand_text_body, brand_text_muted, brand_radius, brand_appearance
  from public.business_settings where id = true
$$;
revoke all on function public.get_brand_kit() from public;
grant execute on function public.get_brand_kit() to anon, authenticated, service_role;
