-- ============================================================================
-- 0083_finance_hardening.sql — Finance Phase A (security hardening)
--
-- 1. Supplier invoice status and amounts can no longer be changed by a direct
--    table write. Status moves only through the security-definer workflow
--    functions (match / resolve hold / approve / record payment), and an
--    approved or paid invoice's amounts are locked. Editing a matched or
--    on-hold invoice (or its lines) sends it back to 'received' for re-match.
-- 2. Supplier payments, payment allocations, payment holds and credit notes
--    are read-only to the app; they are written only by their functions.
-- 3. Reading supplier invoices, payments, holds, credit notes and daily
--    closings needs a finance/purchasing permission — not just "is staff".
-- 4. Approving an invoice is its own permission (invoices.approve), separate
--    from running the match, and records who approved it and when.
-- 5. All of these tables (and cash counts) are now in the audit log.
--
-- The guard tells app writes from workflow writes by current_user: PostgREST
-- runs app requests as 'authenticated'/'anon', while a security-definer
-- function runs as its owner and the API server as 'service_role'.
-- ============================================================================

-- ── 4. Approval permission + who/when ──────────────────────────────────────
alter table public.supplier_invoices
  add column if not exists approved_by uuid,
  add column if not exists approved_at timestamptz;

insert into public.permission_catalog (key, grp, label, type, risk_level) values
  ('invoices.approve', 'Invoices', 'Approve matched supplier invoices for payment', 'approval', 'high')
on conflict (key) do update set grp = excluded.grp, label = excluded.label,
  type = excluded.type, risk_level = excluded.risk_level;
update public.permission_catalog set label = 'Run invoice matching (3-way match)' where key = 'invoices.match';

-- The default Manager could approve before (via invoices.match); keep that.
update public.roles
   set permissions = array_append(permissions, 'invoices.approve')
 where key = 'manager' and 'invoices.match' = any(permissions)
   and not ('invoices.approve' = any(permissions));

create or replace function public.approve_supplier_invoice(p_invoice_id uuid) returns void
language plpgsql security definer set search_path = public, app as $fn$
declare v_row public.supplier_invoices;
begin
  if not (app.has_perm('invoices.approve') or app.has_perm('payables.manage') or app.can_write()) then
    raise exception 'forbidden' using errcode = 'insufficient_privilege';
  end if;
  update public.supplier_invoices
     set status = 'approved', approved_by = app.jwt_sub(), approved_at = now()
   where id = p_invoice_id and status = 'matched'
  returning * into v_row;
  if not found then raise exception 'not_approvable' using errcode = 'check_violation'; end if;
  perform app.log_action('invoice.approved', 'supplier_invoices', p_invoice_id::text, null,
    jsonb_build_object('total_cents', v_row.total_cents, 'supplier_id', v_row.supplier_id));
end $fn$;
revoke all on function public.approve_supplier_invoice(uuid) from public;
grant execute on function public.approve_supplier_invoice(uuid) to authenticated, service_role;

-- ── 1. Invoice guard ────────────────────────────────────────────────────────
-- Owner-only helper so a line edit can send its invoice back for re-match.
create or replace function app.invoice_needs_rematch(p_invoice_id uuid) returns void
language plpgsql security definer set search_path = public, app as $fn$
begin
  update public.supplier_invoices set status = 'received'
   where id = p_invoice_id and status in ('matched', 'on_hold');
end $fn$;
revoke all on function app.invoice_needs_rematch(uuid) from public;

create or replace function app.guard_supplier_invoice() returns trigger
language plpgsql set search_path = public, app as $fn$
begin
  if current_user not in ('authenticated', 'anon') then return coalesce(new, old); end if;

  if tg_op = 'INSERT' then
    if new.status <> 'received' or new.approved_by is not null or new.approved_at is not null then
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

  -- UPDATE
  if new.status is distinct from old.status
     or new.approved_by is distinct from old.approved_by
     or new.approved_at is distinct from old.approved_at
     or new.invoice_ref is distinct from old.invoice_ref then
    raise exception 'invoice_status_via_workflow' using errcode = 'insufficient_privilege',
      hint = 'Use matching, hold resolution, approval or payment to change an invoice''s status.';
  end if;
  if (new.supplier_id, new.purchase_order_id, new.supplier_invoice_number, new.invoice_date, new.due_date,
      new.currency, new.subtotal_cents, new.tax_cents, new.discount_cents, new.delivery_fee_cents, new.total_cents)
     is distinct from
     (old.supplier_id, old.purchase_order_id, old.supplier_invoice_number, old.invoice_date, old.due_date,
      old.currency, old.subtotal_cents, old.tax_cents, old.discount_cents, old.delivery_fee_cents, old.total_cents) then
    if old.status in ('approved', 'partially_paid', 'paid', 'cancelled') then
      raise exception 'invoice_locked' using errcode = 'insufficient_privilege',
        hint = 'An approved or paid invoice cannot be edited.';
    end if;
    if old.status in ('matched', 'on_hold') then
      new.status := 'received';  -- changed amounts must be matched again
    end if;
  end if;
  return new;
end $fn$;

drop trigger if exists guard_supplier_invoice on public.supplier_invoices;
create trigger guard_supplier_invoice before insert or update or delete on public.supplier_invoices
  for each row execute function app.guard_supplier_invoice();

create or replace function app.guard_supplier_invoice_line() returns trigger
language plpgsql set search_path = public, app as $fn$
declare v_invoice uuid := coalesce(new.invoice_id, old.invoice_id); v_status app.invoice_status;
begin
  if current_user not in ('authenticated', 'anon') then return coalesce(new, old); end if;
  select status into v_status from public.supplier_invoices where id = v_invoice;
  if v_status in ('approved', 'partially_paid', 'paid', 'cancelled') then
    raise exception 'invoice_locked' using errcode = 'insufficient_privilege',
      hint = 'Lines of an approved or paid invoice cannot be changed.';
  end if;
  if tg_op = 'UPDATE' and new.invoice_id is distinct from old.invoice_id then
    raise exception 'invoice_line_move_not_allowed' using errcode = 'insufficient_privilege';
  end if;
  if v_status in ('matched', 'on_hold') then
    perform app.invoice_needs_rematch(v_invoice);
  end if;
  return coalesce(new, old);
end $fn$;

drop trigger if exists guard_supplier_invoice_line on public.supplier_invoice_lines;
create trigger guard_supplier_invoice_line before insert or update or delete on public.supplier_invoice_lines
  for each row execute function app.guard_supplier_invoice_line();

-- ── 2 + 3. Access rules ─────────────────────────────────────────────────────
drop policy if exists staff_read on public.supplier_invoices;
create policy staff_read on public.supplier_invoices for select using (
  app.has_perm('invoices.view') or app.has_perm('invoices.create') or app.has_perm('invoices.match')
  or app.has_perm('invoices.approve') or app.has_perm('purchases.view') or app.has_perm('payables.view')
  or app.has_perm('finance.view') or app.can_write());

drop policy if exists staff_read on public.supplier_invoice_lines;
create policy staff_read on public.supplier_invoice_lines for select using (
  app.has_perm('invoices.view') or app.has_perm('invoices.create') or app.has_perm('invoices.match')
  or app.has_perm('invoices.approve') or app.has_perm('purchases.view') or app.has_perm('payables.view')
  or app.has_perm('finance.view') or app.can_write());

drop policy if exists staff_read on public.supplier_payments;
drop policy if exists mgr_write on public.supplier_payments;
create policy staff_read on public.supplier_payments for select using (
  app.has_perm('payables.view') or app.has_perm('payables.record_payment') or app.has_perm('payables.manage')
  or app.has_perm('finance.view') or app.can_write());

drop policy if exists staff_read on public.supplier_payment_allocations;
drop policy if exists mgr_write on public.supplier_payment_allocations;
create policy staff_read on public.supplier_payment_allocations for select using (
  app.has_perm('payables.view') or app.has_perm('payables.record_payment') or app.has_perm('payables.manage')
  or app.has_perm('finance.view') or app.can_write());

drop policy if exists staff_read on public.supplier_payment_holds;
drop policy if exists mgr_write on public.supplier_payment_holds;
create policy staff_read on public.supplier_payment_holds for select using (
  app.has_perm('payables.view') or app.has_perm('payables.manage') or app.has_perm('invoices.view')
  or app.has_perm('invoices.match') or app.has_perm('invoices.approve') or app.has_perm('purchases.view')
  or app.has_perm('finance.view') or app.can_write());

drop policy if exists staff_read on public.supplier_credit_notes;
drop policy if exists mgr_write on public.supplier_credit_notes;
create policy staff_read on public.supplier_credit_notes for select using (
  app.has_perm('payables.view') or app.has_perm('payables.manage') or app.has_perm('finance.view') or app.can_write());

drop policy if exists staff_read on public.daily_closings;
create policy staff_read on public.daily_closings for select using (
  app.has_perm('finance.view') or app.has_perm('finance.close_day') or app.has_perm('finance.reopen_day')
  or app.has_perm('finance.reconcile') or app.can_write());

-- ── 5. Audit coverage ───────────────────────────────────────────────────────
do $$
declare tbl text;
begin
  foreach tbl in array array[
    'supplier_invoices', 'supplier_invoice_lines', 'supplier_payments', 'supplier_payment_allocations',
    'supplier_payment_holds', 'supplier_credit_notes', 'cash_counts'
  ] loop
    execute format('drop trigger if exists audit on public.%I', tbl);
    execute format(
      'create trigger audit after insert or update or delete on public.%I for each row execute function app.audit_row()',
      tbl);
  end loop;
end $$;
