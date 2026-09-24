-- ============================================================================
-- Tenant delta 0061 — read the Priority Allocation switch without
-- settings.view.
--
-- The Priority Allocation page (availability.view) shows whether allocation
-- is ON; business_settings itself is only readable with settings.view, and
-- widening that policy would expose every business setting. This returns
-- just the one flag.
-- ============================================================================

create or replace function public.get_priority_allocation_enabled()
returns boolean language plpgsql stable security definer set search_path = public, app as $fn$
begin
  if not (app.has_perm('availability.view') or app.has_perm('availability.update') or app.is_staff()) then
    raise exception 'forbidden' using errcode = 'insufficient_privilege';
  end if;
  return app.priority_allocation_on();
end;
$fn$;
revoke all on function public.get_priority_allocation_enabled() from public;
grant execute on function public.get_priority_allocation_enabled() to authenticated, service_role;
