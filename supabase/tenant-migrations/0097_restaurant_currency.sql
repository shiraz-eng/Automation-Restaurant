-- ============================================================================
-- 0097 — The restaurant's currency.
--
-- business_settings.currency_code has existed since the start (default USD)
-- and the ledger already copies it onto every financial_events row, but no
-- screen let anyone change it and nothing read it. This adds:
--   • get_currency()  — the code, readable by anyone (the guest menu and the
--     login page format prices too; a currency code is not sensitive)
--   • set_currency()  — settings.update (or owner/manager), from the same list
--     the app offers, audited. It changes how amounts are SHOWN; nothing is
--     converted. Only two-decimal currencies, because amounts are stored in
--     hundredths.
-- ============================================================================

update public.business_settings set currency_code = upper(trim(currency_code))
 where currency_code is distinct from upper(trim(currency_code));

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'business_settings_currency_code_format') then
    alter table public.business_settings
      add constraint business_settings_currency_code_format check (currency_code ~ '^[A-Z]{3}$');
  end if;
end $$;

create or replace function public.get_currency() returns text
language sql stable security definer set search_path = public as $fn$
  select coalesce((select currency_code from public.business_settings where id = true), 'USD')
$fn$;
revoke all on function public.get_currency() from public;
grant execute on function public.get_currency() to anon, authenticated, service_role;

create or replace function public.set_currency(p_code text) returns text
language plpgsql security definer set search_path = public, app as $fn$
declare
  v_code text := upper(trim(coalesce(p_code, '')));
  v_old text;
begin
  if not (app.has_perm('settings.update') or app.can_write()) then
    raise exception 'forbidden' using errcode = 'insufficient_privilege';
  end if;
  -- Keep in step with packages/shared/src/currency.ts (two-decimal currencies only).
  if v_code not in ('PKR','USD','EUR','GBP','AED','SAR','QAR','INR','BDT','LKR','NPR','AFN',
                    'MYR','SGD','THB','TRY','EGP','NGN','KES','ZAR','CAD','AUD','NZD','CNY') then
    raise exception 'unsupported_currency' using errcode = 'check_violation';
  end if;
  select currency_code into v_old from public.business_settings where id = true;
  update public.business_settings set currency_code = v_code where id = true;
  if v_old is distinct from v_code then
    perform app.log_action('settings.currency_changed', 'business_settings', 'currency_code',
      jsonb_build_object('currency_code', v_old), jsonb_build_object('currency_code', v_code));
  end if;
  return v_code;
end $fn$;
revoke all on function public.set_currency(text) from public;
grant execute on function public.set_currency(text) to authenticated, service_role;
