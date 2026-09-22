-- ============================================================================
-- Tenant delta 0049 — Portal identity (meta title) + branded supplier email
--
-- meta_title extends the same business_settings row Brand Kit (0046) and
-- receipt/contact fields (0048) already live on — one restaurant identity
-- row, not a second "portal identity" table. Null falls back to the
-- restaurant's own name (control-plane tenants.restaurant_name), exactly
-- like every other Brand Kit field already falls back to a sensible
-- default when unconfigured.
--
-- get_brand_kit() (0046) is the one narrow, anon-safe Brand Kit read path
-- — extended here to also carry meta_title, rather than adding a second
-- RPC or a direct table read in the portal layouts that need it for
-- <title>/favicon metadata.
-- ============================================================================

alter table public.business_settings
  add column if not exists meta_title text;

-- Postgres refuses CREATE OR REPLACE when a function's RETURNS TABLE column
-- set changes shape (adding meta_title here) — drop first.
drop function if exists public.get_brand_kit();

create function public.get_brand_kit()
returns table(
  logo_url text, primary_color text, primary_fg text,
  bg_main text, bg_surface text, border_color text,
  text_body text, text_muted text, radius text, appearance text,
  meta_title text
)
language sql stable security definer set search_path = public as $$
  select brand_logo_url, brand_primary, brand_primary_fg,
         brand_bg_main, brand_bg_surface, brand_border,
         brand_text_body, brand_text_muted, brand_radius, brand_appearance,
         meta_title
  from public.business_settings where id = true
$$;
revoke all on function public.get_brand_kit() from public;
grant execute on function public.get_brand_kit() to anon, authenticated, service_role;
