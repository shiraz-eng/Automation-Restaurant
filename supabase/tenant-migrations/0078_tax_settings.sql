-- ============================================================================
-- 0078 — tax settings
--
-- The tax rate was hard-coded (8%) in five places in the apps and passed to
-- place_order() by the caller — so the rate was whatever the device sent,
-- including a guest's browser. It is now a restaurant setting:
--
--   * business_settings.tax_enabled / tax_rate_bps (basis points, 800 = 8%).
--     Defaults keep today's behaviour (on, 8%).
--   * app.tax_rate_bps(): the rate to charge now (0 when tax is off).
--   * public.get_tax_settings(): readable by guests too, so the storefront
--     can show the same tax the database will charge.
--   * place_order() charges app.tax_rate_bps() and ignores p_tax_rate_bps
--     (kept only so existing callers keep working). Each order still stores
--     the rate it was charged, so changing the setting never alters
--     orders already placed.
-- ============================================================================

alter table public.business_settings add column if not exists tax_enabled boolean not null default true;
alter table public.business_settings add column if not exists tax_rate_bps integer not null default 800;
alter table public.business_settings drop constraint if exists business_settings_tax_rate_range;
alter table public.business_settings add constraint business_settings_tax_rate_range check (tax_rate_bps between 0 and 5000);

create or replace function app.tax_rate_bps() returns integer
language sql stable security definer set search_path = public, app as $fn$
  select coalesce((select case when tax_enabled then tax_rate_bps else 0 end from public.business_settings where id), 0)
$fn$;

create or replace function public.get_tax_settings()
returns table (tax_enabled boolean, tax_rate_bps integer)
language sql stable security definer set search_path = public, app as $fn$
  select coalesce(b.tax_enabled, true), coalesce(b.tax_rate_bps, 0)
    from (select 1) one left join public.business_settings b on b.id
$fn$;
revoke all on function public.get_tax_settings() from public;
grant execute on function public.get_tax_settings() to anon, authenticated, service_role;

-- place_order(): swap the caller-supplied rate for the restaurant's setting.
-- Patched in place (the function is long and has been redefined by several
-- migrations) and refuses to run if the expected lines aren't there.
do $$
declare
  v_def text;
  v_new text;
begin
  v_def := pg_get_functiondef('public.place_order(text,text,text,integer,jsonb,integer,text,text)'::regprocedure);
  v_new := replace(v_def, 'coalesce(p_tax_rate_bps,0)', 'app.tax_rate_bps()');
  v_new := replace(v_new, 'tax_rate_bps = coalesce(p_tax_rate_bps, 0)', 'tax_rate_bps = app.tax_rate_bps()');
  if v_new = v_def then
    if position('app.tax_rate_bps()' in v_def) > 0 then
      return; -- already patched
    end if;
    raise exception 'place_order(): tax lines not found — not patched';
  end if;
  if position('p_tax_rate_bps,0' in v_new) > 0 or position('coalesce(p_tax_rate_bps' in v_new) > 0 then
    raise exception 'place_order(): a caller-supplied tax rate is still used';
  end if;
  execute v_new;
end $$;
