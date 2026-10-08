-- ============================================================================
-- 0084_invoice_rematch_grant.sql — follow-up to 0083
-- The invoice-line guard runs as the app user, so it needs EXECUTE on the
-- owner-only re-match helper. The helper re-checks the caller may edit
-- invoices, so the grant gives nothing beyond what the line edit already had.
-- ============================================================================
create or replace function app.invoice_needs_rematch(p_invoice_id uuid) returns void
language plpgsql security definer set search_path = public, app as $fn$
begin
  if not (app.has_perm('invoices.create') or app.can_write()) then
    raise exception 'forbidden' using errcode = 'insufficient_privilege';
  end if;
  update public.supplier_invoices set status = 'received'
   where id = p_invoice_id and status in ('matched', 'on_hold');
end $fn$;
revoke all on function app.invoice_needs_rematch(uuid) from public;
grant execute on function app.invoice_needs_rematch(uuid) to authenticated, service_role;
