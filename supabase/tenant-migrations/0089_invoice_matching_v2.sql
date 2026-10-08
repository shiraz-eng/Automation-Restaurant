-- ============================================================================
-- 0089_invoice_matching_v2.sql — Finance Phase D (matching, rejection, history)
--
-- match_supplier_invoice() now checks, and raises a separate typed hold for
-- every problem it finds (previously a quantity problem hid a price problem):
--   total         invoice total ≠ lines + tax + delivery − discount
--   missing_po    line not linked to a purchase-order line
--   supplier      PO belongs to a different supplier than the invoice
--   po_mismatch   line belongs to a different PO than the invoice header
--   missing_grn   nothing received yet against the PO line
--   quantity      billed qty ≠ accepted qty (received − rejected), beyond tolerance
--   price         billed unit price ≠ PO price, beyond tolerance
--   duplicate     this line + other invoices bill more than was accepted
-- The result is stored on the invoice (match_result, matched_at, matched_by).
--
-- reject_supplier_invoice() cancels an unpaid invoice with a reason (an
-- approved one is taken back out of payables by the ledger trigger).
-- supplier_invoice_history() gives the invoice's full trail for the detail
-- screen, to anyone who may view invoices.
-- ============================================================================

alter table public.supplier_invoices
  add column if not exists matched_at       timestamptz,
  add column if not exists matched_by       uuid,
  add column if not exists match_result     jsonb,
  add column if not exists rejected_by      uuid,
  add column if not exists rejected_at      timestamptz,
  add column if not exists rejection_reason text;

alter table public.supplier_payment_holds
  add column if not exists kind text not null default 'other';
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'supplier_payment_holds_kind_check') then
    alter table public.supplier_payment_holds add constraint supplier_payment_holds_kind_check
      check (kind in ('total','missing_po','supplier','po_mismatch','missing_grn','quantity','price','duplicate','other'));
  end if;
end $$;

-- Extend the Phase A guard to the new workflow columns.
create or replace function app.guard_supplier_invoice() returns trigger
language plpgsql set search_path = public, app as $fn$
begin
  if current_user not in ('authenticated', 'anon') then return coalesce(new, old); end if;

  if tg_op = 'INSERT' then
    if new.status <> 'received' or new.approved_by is not null or new.approved_at is not null
       or new.matched_at is not null or new.match_result is not null or new.rejected_at is not null then
      raise exception 'invoice_status_via_workflow' using errcode = 'insufficient_privilege',
        hint = 'New invoices start as received; matching and approval set the status.';
    end if;
    return new;
  end if;

  if tg_op = 'DELETE' then
    if old.status not in ('received', 'on_hold', 'matched')
       or exists (select 1 from public.supplier_payment_allocations a where a.invoice_id = old.id) then
      raise exception 'invoice_locked' using errcode = 'insufficient_privilege',
        hint = 'Approved, paid or part-paid invoices cannot be deleted.';
    end if;
    return old;
  end if;

  if (new.status, new.approved_by, new.approved_at, new.invoice_ref, new.matched_at, new.matched_by,
      new.match_result, new.rejected_by, new.rejected_at, new.rejection_reason)
     is distinct from
     (old.status, old.approved_by, old.approved_at, old.invoice_ref, old.matched_at, old.matched_by,
      old.match_result, old.rejected_by, old.rejected_at, old.rejection_reason) then
    raise exception 'invoice_status_via_workflow' using errcode = 'insufficient_privilege',
      hint = 'Use matching, hold resolution, approval, rejection or payment to change an invoice''s status.';
  end if;
  if (new.supplier_id, new.purchase_order_id, new.supplier_invoice_number, new.invoice_date, new.due_date,
      new.currency, new.subtotal_cents, new.tax_cents, new.discount_cents, new.delivery_fee_cents, new.total_cents)
     is distinct from
     (old.supplier_id, old.purchase_order_id, old.supplier_invoice_number, old.invoice_date, old.due_date,
      old.currency, old.subtotal_cents, old.tax_cents, old.discount_cents, old.delivery_fee_cents, old.total_cents) then
    if old.status in ('approved', 'partially_paid', 'paid', 'cancelled') then
      raise exception 'invoice_locked' using errcode = 'insufficient_privilege',
        hint = 'An approved, paid or cancelled invoice cannot be edited.';
    end if;
    if old.status in ('matched', 'on_hold') then
      new.status := 'received';
    end if;
  end if;
  return new;
end $fn$;

-- ── Matching v2 ─────────────────────────────────────────────────────────────
create or replace function public.match_supplier_invoice(p_invoice_id uuid) returns jsonb
language plpgsql security definer set search_path = public, app as $fn$
declare
  v_inv public.supplier_invoices; v_qty_tol numeric; v_price_tol numeric;
  v_line record; v_po_supplier uuid; v_hdr_po_supplier uuid;
  v_lines_total bigint; v_expected bigint; v_line_count int;
  v_accepted numeric; v_qty_diff numeric; v_price_diff numeric; v_other_billed numeric;
  v_holds jsonb := '[]'::jsonb; v_line_ok boolean; v_sitem_id uuid; v_old_price int;
  v_result jsonb;
begin
  if not (app.has_perm('invoices.match') or app.can_write()) then
    raise exception 'forbidden' using errcode = 'insufficient_privilege';
  end if;
  select * into v_inv from public.supplier_invoices where id = p_invoice_id for update;
  if not found then raise exception 'invoice_not_found' using errcode = 'no_data_found'; end if;
  if v_inv.status not in ('received', 'on_hold', 'matched') then
    raise exception 'not_matchable: invoice is %', v_inv.status using errcode = 'check_violation';
  end if;

  select qty_tolerance_pct, price_tolerance_pct into v_qty_tol, v_price_tol from public.purchasing_settings;
  v_qty_tol := coalesce(v_qty_tol, 2); v_price_tol := coalesce(v_price_tol, 1);

  update public.supplier_payment_holds
     set status = 'resolved', resolved_at = now(), resolved_by = app.jwt_sub(), resolution_note = 'superseded by re-match'
   where invoice_id = p_invoice_id and status = 'open';

  -- Header: total arithmetic and PO supplier.
  select coalesce(sum(line_total_cents), 0), count(*) into v_lines_total, v_line_count
    from public.supplier_invoice_lines where invoice_id = p_invoice_id;
  v_expected := v_lines_total + v_inv.tax_cents + v_inv.delivery_fee_cents - v_inv.discount_cents;
  if v_line_count = 0 then
    v_holds := v_holds || jsonb_build_object('kind', 'other', 'amount_cents', v_inv.total_cents,
      'reason', 'Invoice has no lines to check');
  elsif abs(v_inv.total_cents - v_expected) > greatest(1, round(v_expected * 0.001)) then
    v_holds := v_holds || jsonb_build_object('kind', 'total', 'amount_cents', abs(v_inv.total_cents - v_expected),
      'reason', format('Invoice total %s ≠ lines %s + tax %s + delivery %s − discount %s = %s',
        v_inv.total_cents, v_lines_total, v_inv.tax_cents, v_inv.delivery_fee_cents, v_inv.discount_cents, v_expected));
  end if;
  if v_inv.purchase_order_id is not null then
    select supplier_id into v_hdr_po_supplier from public.purchase_orders where id = v_inv.purchase_order_id;
    if v_hdr_po_supplier is distinct from v_inv.supplier_id then
      v_holds := v_holds || jsonb_build_object('kind', 'supplier', 'amount_cents', v_inv.total_cents,
        'reason', 'The purchase order on this invoice belongs to a different supplier');
    end if;
  end if;

  -- Lines.
  for v_line in
    select sil.id, sil.description, sil.qty, sil.unit_cost_cents, sil.line_total_cents, sil.po_line_id,
           sil.inventory_item_id, pol.purchase_order_id as pol_po, pol.qty as po_qty, pol.received_qty,
           pol.rejected_qty, pol.unit_cost_cents as po_price
      from public.supplier_invoice_lines sil
      left join public.purchase_order_lines pol on pol.id = sil.po_line_id
     where sil.invoice_id = p_invoice_id
     order by sil.description
  loop
    v_line_ok := true;
    if v_line.po_line_id is null then
      v_holds := v_holds || jsonb_build_object('kind', 'missing_po', 'amount_cents', v_line.line_total_cents,
        'reason', format('%s: not linked to a purchase order line', v_line.description));
      continue;
    end if;

    select po.supplier_id into v_po_supplier from public.purchase_orders po where po.id = v_line.pol_po;
    if v_po_supplier is distinct from v_inv.supplier_id then
      v_line_ok := false;
      v_holds := v_holds || jsonb_build_object('kind', 'supplier', 'amount_cents', v_line.line_total_cents,
        'reason', format('%s: its purchase order is with a different supplier', v_line.description));
    end if;
    if v_inv.purchase_order_id is not null and v_line.pol_po is distinct from v_inv.purchase_order_id then
      v_line_ok := false;
      v_holds := v_holds || jsonb_build_object('kind', 'po_mismatch', 'amount_cents', v_line.line_total_cents,
        'reason', format('%s: belongs to a different purchase order than this invoice', v_line.description));
    end if;

    v_accepted := coalesce(v_line.received_qty, 0) - coalesce(v_line.rejected_qty, 0);
    if coalesce(v_line.received_qty, 0) = 0 then
      v_line_ok := false;
      v_holds := v_holds || jsonb_build_object('kind', 'missing_grn', 'amount_cents', v_line.line_total_cents,
        'reason', format('%s: nothing has been received yet (billed %s)', v_line.description, v_line.qty));
    else
      v_qty_diff := case when v_accepted > 0 then abs(v_line.qty - v_accepted) / v_accepted * 100 else 100 end;
      if v_qty_diff > v_qty_tol then
        v_line_ok := false;
        v_holds := v_holds || jsonb_build_object('kind', 'quantity', 'amount_cents', v_line.line_total_cents,
          'reason', format('%s: billed %s, accepted %s%s (%s%% difference)', v_line.description, v_line.qty, v_accepted,
            case when coalesce(v_line.rejected_qty, 0) > 0 then format(' after %s rejected', v_line.rejected_qty) else '' end,
            round(v_qty_diff, 1)));
      end if;
      select coalesce(sum(o.qty), 0) into v_other_billed
        from public.supplier_invoice_lines o join public.supplier_invoices oi on oi.id = o.invoice_id
       where o.po_line_id = v_line.po_line_id and o.invoice_id <> p_invoice_id and oi.status <> 'cancelled';
      if v_other_billed > 0 and v_other_billed + v_line.qty > v_accepted * (1 + v_qty_tol / 100) then
        v_line_ok := false;
        v_holds := v_holds || jsonb_build_object('kind', 'duplicate', 'amount_cents', v_line.line_total_cents,
          'reason', format('%s: %s already billed on other invoices; with this one %s of %s accepted',
            v_line.description, v_other_billed, v_other_billed + v_line.qty, v_accepted));
      end if;
    end if;

    v_price_diff := case when coalesce(v_line.po_price, 0) > 0
      then abs(v_line.unit_cost_cents - v_line.po_price) / v_line.po_price::numeric * 100 else 100 end;
    if v_price_diff > v_price_tol then
      v_line_ok := false;
      v_holds := v_holds || jsonb_build_object('kind', 'price', 'amount_cents', v_line.line_total_cents,
        'reason', format('%s: billed %s per unit, PO price %s (%s%% difference)', v_line.description,
          v_line.unit_cost_cents, coalesce(v_line.po_price, 0), round(v_price_diff, 1)));
    end if;

    -- A clean line confirms the supplier's current price.
    if v_line_ok and v_line.inventory_item_id is not null then
      select si.id, si.current_price_cents into v_sitem_id, v_old_price
        from public.supplier_items si
       where si.supplier_id = v_inv.supplier_id and si.inventory_item_id = v_line.inventory_item_id;
      if v_sitem_id is not null and v_old_price is distinct from v_line.unit_cost_cents then
        perform public.set_supplier_item_price(v_sitem_id, v_line.unit_cost_cents, 'invoice', p_invoice_id);
      end if;
    end if;
  end loop;

  insert into public.supplier_payment_holds (invoice_id, kind, reason, amount_cents, created_by)
  select p_invoice_id, h->>'kind', h->>'reason', (h->>'amount_cents')::int, app.jwt_sub()
    from jsonb_array_elements(v_holds) h;

  v_result := jsonb_build_object(
    'matched', jsonb_array_length(v_holds) = 0,
    'holds', v_holds,
    'lines_checked', v_line_count,
    'invoice_total_cents', v_inv.total_cents,
    'expected_total_cents', v_expected,
    'unmatched_amount_cents', coalesce((select sum((h->>'amount_cents')::bigint) from jsonb_array_elements(v_holds) h), 0),
    'qty_tolerance_pct', v_qty_tol, 'price_tolerance_pct', v_price_tol);

  update public.supplier_invoices
     set status = case when jsonb_array_length(v_holds) = 0 then 'matched'::app.invoice_status else 'on_hold'::app.invoice_status end,
         matched_at = now(), matched_by = app.jwt_sub(), match_result = v_result
   where id = p_invoice_id;

  perform app.log_action('invoice.matched', 'supplier_invoices', p_invoice_id::text, null,
    jsonb_build_object('matched', jsonb_array_length(v_holds) = 0, 'holds', jsonb_array_length(v_holds)));
  return v_result;
end $fn$;
revoke all on function public.match_supplier_invoice(uuid) from public;
grant execute on function public.match_supplier_invoice(uuid) to authenticated, service_role;

-- ── Rejection ───────────────────────────────────────────────────────────────
create or replace function public.reject_supplier_invoice(p_invoice_id uuid, p_reason text) returns void
language plpgsql security definer set search_path = public, app as $fn$
declare v_inv public.supplier_invoices;
begin
  if not (app.has_perm('invoices.approve') or app.has_perm('payables.manage') or app.can_write()) then
    raise exception 'forbidden' using errcode = 'insufficient_privilege';
  end if;
  if coalesce(trim(p_reason), '') = '' then raise exception 'reason_required' using errcode = 'check_violation'; end if;
  select * into v_inv from public.supplier_invoices where id = p_invoice_id for update;
  if not found then raise exception 'invoice_not_found' using errcode = 'no_data_found'; end if;
  if v_inv.status not in ('received', 'on_hold', 'matched', 'approved')
     or exists (select 1 from public.supplier_payment_allocations where invoice_id = p_invoice_id)
     or exists (select 1 from public.supplier_credit_notes where invoice_id = p_invoice_id) then
    raise exception 'not_rejectable: invoice has payments or credits, or is already %', v_inv.status
      using errcode = 'check_violation';
  end if;
  update public.supplier_payment_holds
     set status = 'resolved', resolved_at = now(), resolved_by = app.jwt_sub(), resolution_note = 'invoice rejected'
   where invoice_id = p_invoice_id and status = 'open';
  update public.supplier_invoices
     set status = 'cancelled', rejected_by = app.jwt_sub(), rejected_at = now(), rejection_reason = trim(p_reason)
   where id = p_invoice_id;
  perform app.log_action('invoice.rejected', 'supplier_invoices', p_invoice_id::text,
    jsonb_build_object('status', v_inv.status), jsonb_build_object('status', 'cancelled', 'reason', trim(p_reason)));
end $fn$;
revoke all on function public.reject_supplier_invoice(uuid, text) from public;
grant execute on function public.reject_supplier_invoice(uuid, text) to authenticated, service_role;

-- ── History for the detail screen ───────────────────────────────────────────
create or replace function public.supplier_invoice_history(p_invoice_id uuid)
returns table (at timestamptz, kind text, actor text, amount_cents bigint, detail text)
language plpgsql stable security definer set search_path = public, app as $fn$
begin
  if not (app.has_perm('invoices.view') or app.has_perm('invoices.create') or app.has_perm('invoices.match')
          or app.has_perm('invoices.approve') or app.has_perm('payables.view') or app.has_perm('purchases.view')
          or app.has_perm('finance.view') or app.can_write()) then
    raise exception 'forbidden' using errcode = 'insufficient_privilege';
  end if;
  return query
  with who as (select user_id, coalesce(nullif(full_name, ''), email) as name from public.memberships where user_id is not null),
  ev as (
    select i.created_at as at, 'created'::text as kind, i.created_by as by, i.total_cents::bigint as amt,
           format('Invoice %s recorded', i.supplier_invoice_number) as detail
      from public.supplier_invoices i where i.id = p_invoice_id
    union all
    select i.matched_at, case when i.status = 'on_hold' or (i.match_result->>'matched')::boolean is false then 'match_failed' else 'matched' end,
           i.matched_by, null, format('%s line(s) checked, %s problem(s)', i.match_result->>'lines_checked',
             jsonb_array_length(coalesce(i.match_result->'holds', '[]'::jsonb)))
      from public.supplier_invoices i where i.id = p_invoice_id and i.matched_at is not null
    union all
    select h.created_at, 'hold', h.created_by, h.amount_cents::bigint, h.reason
      from public.supplier_payment_holds h where h.invoice_id = p_invoice_id and coalesce(h.resolution_note, '') <> 'superseded by re-match'
    union all
    select h.resolved_at, 'hold_resolved', h.resolved_by, null, coalesce(h.resolution_note, 'resolved') || ' — ' || h.reason
      from public.supplier_payment_holds h
     where h.invoice_id = p_invoice_id and h.status = 'resolved' and h.resolution_note not in ('superseded by re-match', 'invoice rejected')
    union all
    select i.approved_at, 'approved', i.approved_by, i.total_cents::bigint, 'Approved for payment'
      from public.supplier_invoices i where i.id = p_invoice_id and i.approved_at is not null
    union all
    select i.rejected_at, 'rejected', i.rejected_by, null, i.rejection_reason
      from public.supplier_invoices i where i.id = p_invoice_id and i.rejected_at is not null
    union all
    select sp.paid_at, 'payment', sp.created_by, a.amount_cents::bigint,
           concat_ws(' · ', replace(sp.method, '_', ' '), nullif(sp.reference, ''))
      from public.supplier_payment_allocations a join public.supplier_payments sp on sp.id = a.payment_id
     where a.invoice_id = p_invoice_id
    union all
    select c.created_at, 'credit_note', c.created_by, c.amount_cents::bigint, c.reason
      from public.supplier_credit_notes c where c.invoice_id = p_invoice_id
  )
  select ev.at, ev.kind, coalesce(w.name, case when ev.by is null then 'System' else 'Staff member' end), ev.amt, ev.detail
    from ev left join who w on w.user_id = ev.by
   where ev.at is not null
   order by ev.at, ev.kind;
end $fn$;
revoke all on function public.supplier_invoice_history(uuid) from public;
grant execute on function public.supplier_invoice_history(uuid) to authenticated, service_role;
