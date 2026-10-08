-- ============================================================================
-- 0090_match_duplicate_scope.sql — follow-up to 0089
-- "Already billed" counts only invoices that were accepted (matched, approved,
-- part-paid or paid). Counting unchecked or on-hold invoices too meant the
-- first, legitimate invoice was flagged as a duplicate as soon as a second
-- one for the same goods was keyed in.
-- ============================================================================
do $$
declare v_def text; v_new text;
begin
  v_def := pg_get_functiondef('public.match_supplier_invoice(uuid)'::regprocedure);
  v_new := replace(v_def,
    'where o.po_line_id = v_line.po_line_id and o.invoice_id <> p_invoice_id and oi.status <> ''cancelled'';',
    'where o.po_line_id = v_line.po_line_id and o.invoice_id <> p_invoice_id
         and oi.status in (''matched'', ''approved'', ''partially_paid'', ''paid'');');
  if v_new = v_def then
    if position('oi.status in (''matched''' in v_def) = 0 then
      raise exception 'match_supplier_invoice duplicate filter not found — patch it by hand';
    end if;
  else
    execute v_new;
  end if;
end $$;
