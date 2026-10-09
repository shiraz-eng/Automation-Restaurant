-- ============================================================================
-- 0095 — Approving (or rejecting) a supplier invoice needs invoices.approve.
--
-- 0083 / 0089 also let payables.manage approve and reject, for compatibility.
-- That let the person who pays suppliers approve their own bills. Now only
-- invoices.approve (or an owner / manager, via app.can_write()) can; paying
-- stays payables.record_payment. The function bodies are otherwise unchanged
-- — only the permission line is rewritten.
--
-- Affected on 2026-10-08: the built-in Accountant role (payables.manage, no
-- invoices.approve) in every reachable restaurant — accountants still record
-- payments; approval moves to owners, managers or an explicit grant.
-- ============================================================================

do $mig$
declare
  fn text;
  def text;
  old_check constant text := $c$app.has_perm('invoices.approve') or app.has_perm('payables.manage') or app.can_write()$c$;
  new_check constant text := $c$app.has_perm('invoices.approve') or app.can_write()$c$;
begin
  foreach fn in array array['public.approve_supplier_invoice(uuid)', 'public.reject_supplier_invoice(uuid, text)'] loop
    def := pg_get_functiondef(fn::regprocedure);
    if position(old_check in def) > 0 then
      execute replace(def, old_check, new_check);
    elsif position(new_check in def) = 0 then
      raise exception '0095: unexpected permission check in %', fn;
    end if;
  end loop;
end $mig$;

update public.permission_catalog
   set label = 'Approve or reject matched supplier invoices (separate from paying them)'
 where key = 'invoices.approve';
