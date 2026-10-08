-- ============================================================================
-- 0087_expense_workflow.sql — Finance Phase C (expense workflow)
--
-- Expenses get a controlled lifecycle:
--   draft → submitted → approved → paid        (rejected / void on the side)
-- Only APPROVED and PAID expenses are operating costs: they count in
-- period_profitability() and post to the financial ledger. Drafts, submitted,
-- rejected and void expenses don't affect profit.
--
-- Status and the who/when fields move only through the workflow functions
-- below (a guard blocks direct edits from the app). An expense can be edited
-- or deleted only before approval; an approved or paid one is corrected by
-- voiding it with a reason (the ledger posts a reversal).
--
-- Existing expenses were real recorded spend, so they become 'paid' and
-- today's profit figures don't change. New ones default to 'submitted'.
--
-- Also: a private 'expense-receipts' bucket for receipt attachments, and the
-- supplier-invoices bucket no longer lets every staff member read files.
-- ============================================================================

alter table public.expenses
  add column if not exists status            text not null default 'paid',
  add column if not exists vendor            text,
  add column if not exists payment_method    text,
  add column if not exists payment_reference text,
  add column if not exists attachment_path   text,
  add column if not exists submitted_by      uuid,
  add column if not exists submitted_at      timestamptz,
  add column if not exists approved_by       uuid,
  add column if not exists approved_at       timestamptz,
  add column if not exists rejected_by       uuid,
  add column if not exists rejected_at       timestamptz,
  add column if not exists rejection_reason  text,
  add column if not exists paid_by           uuid,
  add column if not exists paid_at           timestamptz,
  add column if not exists voided_by         uuid,
  add column if not exists voided_at         timestamptz,
  add column if not exists void_reason       text;

update public.expenses
   set submitted_by = coalesce(submitted_by, recorded_by),
       submitted_at = coalesce(submitted_at, created_at),
       approved_at  = coalesce(approved_at, created_at),
       paid_at      = coalesce(paid_at, created_at)
 where status = 'paid';

alter table public.expenses alter column status set default 'submitted';
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'expenses_status_check') then
    alter table public.expenses add constraint expenses_status_check
      check (status in ('draft', 'submitted', 'approved', 'rejected', 'paid', 'void'));
  end if;
end $$;
create index if not exists expenses_status_date_idx on public.expenses (status, expense_date desc);

insert into public.permission_catalog (key, grp, label, type, risk_level) values
  ('finance.approve_expense', 'Finance', 'Approve, reject or void expenses', 'approval', 'high'),
  ('finance.pay_expense',     'Finance', 'Mark approved expenses as paid',  'write',    'high')
on conflict (key) do update set grp = excluded.grp, label = excluded.label,
  type = excluded.type, risk_level = excluded.risk_level;

-- ── Guard: status moves only through the workflow functions ─────────────────
create or replace function app.guard_expense() returns trigger
language plpgsql set search_path = public, app as $fn$
begin
  if current_user not in ('authenticated', 'anon') then return coalesce(new, old); end if;

  if tg_op = 'INSERT' then
    if new.status not in ('draft', 'submitted') then
      raise exception 'expense_status_via_workflow' using errcode = 'insufficient_privilege',
        hint = 'New expenses start as a draft or submitted; approval and payment set the rest.';
    end if;
    new.recorded_by := coalesce(new.recorded_by, app.jwt_sub());
    new.submitted_by := case when new.status = 'submitted' then app.jwt_sub() end;
    new.submitted_at := case when new.status = 'submitted' then now() end;
    new.approved_by := null; new.approved_at := null; new.rejected_by := null; new.rejected_at := null;
    new.rejection_reason := null; new.paid_by := null; new.paid_at := null;
    new.voided_by := null; new.voided_at := null; new.void_reason := null;
    return new;
  end if;

  if tg_op = 'DELETE' then
    if old.status not in ('draft', 'submitted', 'rejected') then
      raise exception 'expense_locked' using errcode = 'insufficient_privilege',
        hint = 'Approved or paid expenses cannot be deleted; void them with a reason instead.';
    end if;
    return old;
  end if;

  if (new.status, new.submitted_by, new.submitted_at, new.approved_by, new.approved_at, new.rejected_by,
      new.rejected_at, new.rejection_reason, new.paid_by, new.paid_at, new.voided_by, new.voided_at,
      new.void_reason, new.recorded_by, new.payment_method, new.payment_reference)
     is distinct from
     (old.status, old.submitted_by, old.submitted_at, old.approved_by, old.approved_at, old.rejected_by,
      old.rejected_at, old.rejection_reason, old.paid_by, old.paid_at, old.voided_by, old.voided_at,
      old.void_reason, old.recorded_by, old.payment_method, old.payment_reference) then
    raise exception 'expense_status_via_workflow' using errcode = 'insufficient_privilege',
      hint = 'Use submit, approve, reject, pay or void to change an expense''s status.';
  end if;
  if (new.category, new.description, new.amount_cents, new.expense_date, new.supplier_id, new.vendor)
     is distinct from
     (old.category, old.description, old.amount_cents, old.expense_date, old.supplier_id, old.vendor)
     and old.status not in ('draft', 'submitted', 'rejected') then
    raise exception 'expense_locked' using errcode = 'insufficient_privilege',
      hint = 'Approved or paid expenses cannot be edited; void them with a reason instead.';
  end if;
  if new.attachment_path is distinct from old.attachment_path and old.status = 'void' then
    raise exception 'expense_locked' using errcode = 'insufficient_privilege';
  end if;
  return new;
end $fn$;
drop trigger if exists guard_expense on public.expenses;
create trigger guard_expense before insert or update or delete on public.expenses
  for each row execute function app.guard_expense();

-- ── Workflow functions ──────────────────────────────────────────────────────
create or replace function app.expense_transition(
  p_id uuid, p_from text[], p_to text, p_action text, p_extra jsonb default '{}'::jsonb
) returns public.expenses
language plpgsql security definer set search_path = public, app as $fn$
declare v_old public.expenses; v_row public.expenses;
begin
  select * into v_old from public.expenses where id = p_id for update;
  if not found then raise exception 'expense_not_found' using errcode = 'no_data_found'; end if;
  if not (v_old.status = any(p_from)) then
    raise exception 'expense_wrong_status: % cannot be %', v_old.status, p_action using errcode = 'check_violation';
  end if;
  update public.expenses set
    status = p_to,
    submitted_by = case when p_to = 'submitted' then app.jwt_sub() else submitted_by end,
    submitted_at = case when p_to = 'submitted' then now() else submitted_at end,
    approved_by = case when p_to = 'approved' then app.jwt_sub() when p_to = 'submitted' then null else approved_by end,
    approved_at = case when p_to = 'approved' then now() when p_to = 'submitted' then null else approved_at end,
    rejected_by = case when p_to = 'rejected' then app.jwt_sub() when p_to = 'submitted' then null else rejected_by end,
    rejected_at = case when p_to = 'rejected' then now() when p_to = 'submitted' then null else rejected_at end,
    rejection_reason = case when p_to = 'rejected' then p_extra->>'reason' when p_to = 'submitted' then null else rejection_reason end,
    paid_by = case when p_to = 'paid' then app.jwt_sub() else paid_by end,
    paid_at = case when p_to = 'paid' then coalesce((p_extra->>'paid_at')::timestamptz, now()) else paid_at end,
    payment_method = case when p_to = 'paid' then p_extra->>'method' else payment_method end,
    payment_reference = case when p_to = 'paid' then nullif(p_extra->>'reference', '') else payment_reference end,
    voided_by = case when p_to = 'void' then app.jwt_sub() else voided_by end,
    voided_at = case when p_to = 'void' then now() else voided_at end,
    void_reason = case when p_to = 'void' then p_extra->>'reason' else void_reason end
  where id = p_id
  returning * into v_row;
  perform app.log_action('expense.' || p_action, 'expenses', p_id::text,
    jsonb_build_object('status', v_old.status),
    jsonb_build_object('status', v_row.status, 'amount_cents', v_row.amount_cents) || coalesce(p_extra, '{}'::jsonb));
  return v_row;
end $fn$;
revoke all on function app.expense_transition(uuid, text[], text, text, jsonb) from public;

create or replace function public.submit_expense(p_id uuid) returns public.expenses
language plpgsql security definer set search_path = public, app as $fn$
begin
  if not (app.has_perm('finance.create_expense') or app.has_perm('finance.update_expense')) then
    raise exception 'forbidden' using errcode = 'insufficient_privilege';
  end if;
  return app.expense_transition(p_id, array['draft', 'rejected'], 'submitted', 'submitted');
end $fn$;

create or replace function public.approve_expense(p_id uuid) returns public.expenses
language plpgsql security definer set search_path = public, app as $fn$
begin
  if not app.has_perm('finance.approve_expense') then
    raise exception 'forbidden' using errcode = 'insufficient_privilege';
  end if;
  return app.expense_transition(p_id, array['submitted'], 'approved', 'approved');
end $fn$;

create or replace function public.reject_expense(p_id uuid, p_reason text) returns public.expenses
language plpgsql security definer set search_path = public, app as $fn$
begin
  if not app.has_perm('finance.approve_expense') then
    raise exception 'forbidden' using errcode = 'insufficient_privilege';
  end if;
  if coalesce(trim(p_reason), '') = '' then raise exception 'reason_required' using errcode = 'check_violation'; end if;
  return app.expense_transition(p_id, array['submitted', 'approved'], 'rejected', 'rejected',
    jsonb_build_object('reason', trim(p_reason)));
end $fn$;

create or replace function public.pay_expense(
  p_id uuid, p_method text, p_reference text default null, p_paid_on date default null
) returns public.expenses
language plpgsql security definer set search_path = public, app as $fn$
begin
  if not app.has_perm('finance.pay_expense') then
    raise exception 'forbidden' using errcode = 'insufficient_privilege';
  end if;
  if coalesce(p_method, '') not in ('cash', 'card', 'bank_transfer', 'cheque', 'digital_wallet', 'other') then
    raise exception 'bad_payment_method' using errcode = 'check_violation';
  end if;
  return app.expense_transition(p_id, array['approved'], 'paid', 'paid',
    jsonb_build_object('method', p_method, 'reference', coalesce(p_reference, ''),
      'paid_at', case when p_paid_on is null then null else (p_paid_on::timestamp + interval '12 hours')::timestamptz end));
end $fn$;

create or replace function public.void_expense(p_id uuid, p_reason text) returns public.expenses
language plpgsql security definer set search_path = public, app as $fn$
begin
  if not app.has_perm('finance.approve_expense') then
    raise exception 'forbidden' using errcode = 'insufficient_privilege';
  end if;
  if coalesce(trim(p_reason), '') = '' then raise exception 'reason_required' using errcode = 'check_violation'; end if;
  return app.expense_transition(p_id, array['approved', 'paid'], 'void', 'voided',
    jsonb_build_object('reason', trim(p_reason)));
end $fn$;

do $$
declare f text;
begin
  foreach f in array array['submit_expense(uuid)', 'approve_expense(uuid)', 'reject_expense(uuid,text)',
                           'pay_expense(uuid,text,text,date)', 'void_expense(uuid,text)'] loop
    execute format('revoke all on function public.%s from public', f);
    execute format('grant execute on function public.%s to authenticated, service_role', f);
  end loop;
end $$;

-- ── Ledger: only approved / paid expenses are operating costs ──────────────
create or replace function app.ledger_on_expense() returns trigger
language plpgsql security definer set search_path = public, app as $fn$
declare
  v_row public.expenses := coalesce(new, old);
  v_target bigint := 0; v_bal bigint; v_old_date date; v_type text;
begin
  if tg_op <> 'DELETE' and new.status in ('approved', 'paid') then v_target := new.amount_cents; end if;
  select coalesce(sum(signed_cents), 0) into v_bal
    from public.financial_events where source_table = 'expenses' and source_id = v_row.id and category = 'expense';
  v_old_date := case when tg_op = 'INSERT' then null else old.expense_date end;

  -- A posted expense whose date moved: take it off the old day, then post on the new one.
  if tg_op = 'UPDATE' and v_bal <> 0 and new.expense_date is distinct from old.expense_date then
    perform app.ledger_post('EXPENSE_REVERSED', 'expense', (-1)::smallint, v_bal, now(), 'expenses', old.id,
      old.expense_date, null, old.supplier_id, null, jsonb_build_object('cause', 'date_changed', 'new_date', new.expense_date));
    v_bal := 0;
  end if;

  if v_target <> v_bal then
    v_type := case
      when v_target = 0 and tg_op = 'DELETE' then 'EXPENSE_REVERSED'
      when v_target = 0 and new.status = 'void' then 'EXPENSE_VOIDED'
      when v_target = 0 and new.status = 'rejected' then 'EXPENSE_REJECTED'
      when v_target = 0 then 'EXPENSE_REVERSED'
      when v_bal = 0 then 'EXPENSE_APPROVED'
      else 'EXPENSE_ADJUSTED' end;
    perform app.ledger_post(v_type, 'expense', sign(v_target - v_bal)::smallint, v_target - v_bal, now(),
      'expenses', v_row.id, v_row.expense_date, null, v_row.supplier_id, v_row.payment_method,
      jsonb_build_object('category', v_row.category, 'description', v_row.description, 'status', v_row.status,
        'vendor', v_row.vendor, 'reason', coalesce(v_row.void_reason, v_row.rejection_reason)));
  end if;

  if tg_op = 'UPDATE' and new.status = 'paid' and old.status is distinct from 'paid' then
    perform app.ledger_post('EXPENSE_PAID', 'expense', 0::smallint, new.amount_cents, coalesce(new.paid_at, now()),
      'expenses', new.id, null, null, new.supplier_id, new.payment_method,
      jsonb_build_object('reference', new.payment_reference, 'category', new.category));
  end if;
  return null;
end $fn$;

-- ── Profit counts only approved / paid expenses ─────────────────────────────
do $$
declare v_def text; v_new text;
begin
  v_def := pg_get_functiondef('public.period_profitability(timestamptz, timestamptz)'::regprocedure);
  v_new := replace(v_def,
    'where expense_date <= app.local_date(p_to - interval ''1 microsecond'')',
    'where expense_date <= app.local_date(p_to - interval ''1 microsecond'') and status in (''approved'', ''paid'')');
  if v_new = v_def then
    if position('status in (''approved'', ''paid'')' in v_def) = 0 then
      raise exception 'period_profitability expense filter not found — patch it by hand';
    end if;
  else
    execute v_new;
  end if;
end $$;

-- ── Receipts storage ────────────────────────────────────────────────────────
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('expense-receipts', 'expense-receipts', false, 10485760,
        array['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/heic'])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "expense-receipts read" on storage.objects;
create policy "expense-receipts read" on storage.objects for select
  using (bucket_id = 'expense-receipts' and (app.has_perm('finance.view') or app.has_perm('finance.create_expense')
    or app.has_perm('finance.approve_expense') or app.can_write()));
drop policy if exists "expense-receipts upload" on storage.objects;
create policy "expense-receipts upload" on storage.objects for insert
  with check (bucket_id = 'expense-receipts' and (app.has_perm('finance.create_expense')
    or app.has_perm('finance.update_expense') or app.can_write()));

drop policy if exists "supplier-invoices staff read" on storage.objects;
create policy "supplier-invoices staff read" on storage.objects for select
  using (bucket_id = 'supplier-invoices' and (app.has_perm('invoices.view') or app.has_perm('invoices.create')
    or app.has_perm('invoices.match') or app.has_perm('invoices.approve') or app.has_perm('payables.view')
    or app.has_perm('finance.view') or app.can_write()));
