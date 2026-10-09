-- ============================================================================
-- 0092_cash_and_day_close.sql — Finance Phase F (cash management, day close)
--
-- 1. cash_movements: pay-ins, pay-outs, bank drops and adjustments to the
--    drawer, each with a reason. Written only by record_cash_movement();
--    never edited — a mistake is corrected with an adjustment.
-- 2. Expected cash = opening float + cash sales (net of refunds) + movements,
--    used by cash counts and by the day close.
-- 3. day_close_preview(): everything the close screen shows — sales, tax,
--    payments by method, the cash drawer, expenses and supplier payments of
--    the day, and unresolved exceptions.
-- 4. close_business_day(): refuses future days and already-closed days,
--    needs a reason when counted cash differs from expected, and stores the
--    full summary. reopen_business_day() needs a reason.
-- 5. A closed day is locked: no new/edited expenses, cash counts or cash
--    movements dated that day, and no voids, price changes or deletions of
--    that day's completed sales or their payments. Refunds stay possible
--    (they are recorded on the day they happen); workflow steps on expenses
--    (approve / pay / void) stay possible and are audited.
-- ============================================================================

-- ── 1. Cash movements ───────────────────────────────────────────────────────
create table if not exists public.cash_movements (
  id            uuid primary key default gen_random_uuid(),
  business_date date not null,
  kind          text not null check (kind in ('pay_in', 'pay_out', 'bank_drop', 'adjustment')),
  amount_cents  int not null,
  signed_cents  int generated always as (
                  case when kind in ('pay_out', 'bank_drop') then -abs(amount_cents)
                       when kind = 'pay_in' then abs(amount_cents)
                       else amount_cents end) stored,
  reason        text not null check (length(trim(reason)) > 0),
  reference     text,
  created_by    uuid,
  created_at    timestamptz not null default now(),
  check ((kind = 'adjustment' and amount_cents <> 0) or (kind <> 'adjustment' and amount_cents > 0))
);
create index if not exists cash_movements_date_idx on public.cash_movements (business_date desc, created_at desc);
alter table public.cash_movements enable row level security;
drop policy if exists staff_read on public.cash_movements;
create policy staff_read on public.cash_movements for select using (
  app.has_perm('finance.view') or app.has_perm('finance.reconcile') or app.has_perm('cash.manage')
  or app.has_perm('finance.close_day') or app.can_write());
revoke insert, update, delete, truncate on public.cash_movements from anon, authenticated;
drop trigger if exists audit on public.cash_movements;
create trigger audit after insert or update or delete on public.cash_movements
  for each row execute function app.audit_row();
drop trigger if exists ledger_no_update on public.cash_movements;
create trigger ledger_no_update before update or delete on public.cash_movements
  for each row execute function app.ledger_immutable();

insert into public.permission_catalog (key, grp, label, type, risk_level) values
  ('cash.manage', 'Finance', 'Record cash drawer pay-ins, pay-outs and bank drops', 'write', 'high')
on conflict (key) do update set grp = excluded.grp, label = excluded.label, type = excluded.type, risk_level = excluded.risk_level;

create or replace function app.day_cash_movements(p_date date) returns int
language sql stable set search_path = public, app as $fn$
  select coalesce(sum(signed_cents), 0)::int from public.cash_movements where business_date = p_date
$fn$;

create or replace function app.is_day_closed(p_date date) returns boolean
language sql stable set search_path = public, app as $fn$
  select p_date is not null and exists (select 1 from public.daily_closings where business_date = p_date and status = 'closed')
$fn$;

create or replace function public.record_cash_movement(
  p_business_date date, p_kind text, p_amount_cents int, p_reason text, p_reference text default null
) returns public.cash_movements
language plpgsql security definer set search_path = public, app as $fn$
declare v_row public.cash_movements;
begin
  if not (app.has_perm('cash.manage') or app.has_perm('finance.reconcile')) then
    raise exception 'forbidden' using errcode = 'insufficient_privilege';
  end if;
  if coalesce(trim(p_reason), '') = '' then raise exception 'reason_required' using errcode = 'check_violation'; end if;
  if p_business_date > app.business_day(now()) then raise exception 'future_day' using errcode = 'check_violation'; end if;
  insert into public.cash_movements (business_date, kind, amount_cents, reason, reference, created_by)
  values (coalesce(p_business_date, app.business_day(now())), p_kind, p_amount_cents, trim(p_reason), nullif(trim(p_reference), ''), app.jwt_sub())
  returning * into v_row;
  perform app.log_action('cash.movement', 'cash_movements', v_row.id::text, null,
    jsonb_build_object('kind', p_kind, 'amount_cents', v_row.signed_cents, 'reason', trim(p_reason), 'business_date', v_row.business_date));
  return v_row;
end $fn$;
revoke all on function public.record_cash_movement(date, text, int, text, text) from public;
grant execute on function public.record_cash_movement(date, text, int, text, text) to authenticated, service_role;

create or replace function app.ledger_on_cash_movement() returns trigger
language plpgsql security definer set search_path = public, app as $fn$
begin
  perform app.ledger_post('CASH_MOVEMENT', 'cash', sign(new.signed_cents)::smallint, abs(new.signed_cents)::bigint, new.created_at,
    'cash_movements', new.id, new.business_date, null, null, 'cash',
    jsonb_build_object('kind', new.kind, 'reason', new.reason, 'reference', new.reference));
  return null;
end $fn$;
drop trigger if exists ledger_sync on public.cash_movements;
create trigger ledger_sync after insert on public.cash_movements
  for each row execute function app.ledger_on_cash_movement();

-- ── 2. Expected cash includes movements ─────────────────────────────────────
create or replace function public.record_cash_count(
  p_business_date date, p_opening_cents int, p_counted_cents int, p_note text default null
) returns public.cash_counts language plpgsql security definer set search_path = public, app as $fn$
declare v_expected int; v_row public.cash_counts;
begin
  if not app.has_perm('finance.reconcile') then
    raise exception 'forbidden' using errcode = 'insufficient_privilege';
  end if;
  if coalesce(p_counted_cents, -1) < 0 or coalesce(p_opening_cents, 0) < 0 then
    raise exception 'bad_amount' using errcode = 'check_violation';
  end if;
  v_expected := coalesce(p_opening_cents, 0)
              + coalesce((app.day_sales(p_business_date)->>'cash_in_cents')::int, 0)
              + app.day_cash_movements(p_business_date);
  insert into public.cash_counts
    (business_date, opening_cents, counted_cents, expected_cents, difference_cents, note, counted_by, counted_by_email)
  values
    (p_business_date, coalesce(p_opening_cents, 0), p_counted_cents, v_expected, p_counted_cents - v_expected,
     nullif(trim(p_note), ''), app.jwt_sub(),
     nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'email')
  returning * into v_row;
  perform app.log_action('cash.counted', 'cash_counts', v_row.id::text, null,
                         jsonb_build_object('counted', p_counted_cents, 'expected', v_expected));
  return v_row;
end $fn$;
revoke all on function public.record_cash_count(date, int, int, text) from public;
grant execute on function public.record_cash_count(date, int, int, text) to authenticated, service_role;

-- ── 3. Close preview ────────────────────────────────────────────────────────
alter table public.daily_closings
  add column if not exists cash_movements_cents int not null default 0,
  add column if not exists summary jsonb;

create or replace function public.day_close_preview(p_business_date date, p_opening_cents int default 0)
returns jsonb language plpgsql stable security definer set search_path = public, app as $fn$
declare
  v_s jsonb; v_mov int; v_tax bigint; v_mix jsonb; v_exp jsonb; v_supp jsonb; v_count jsonb;
  v_open_orders int; v_unpaid jsonb; v_awaiting int; v_holds int; v_closing public.daily_closings;
begin
  if not (app.has_perm('finance.close_day') or app.has_perm('finance.view') or app.has_perm('finance.reconcile')) then
    raise exception 'forbidden' using errcode = 'insufficient_privilege';
  end if;
  v_s := app.day_sales(p_business_date);
  v_mov := app.day_cash_movements(p_business_date);

  with o as (
    select * from public.orders
     where status in ('served', 'paid') and app.business_day(coalesce(paid_at, created_at)) = p_business_date
  )
  select coalesce(sum(tax_cents), 0) into v_tax from o;

  with o as (
    select id from public.orders
     where status in ('served', 'paid') and app.business_day(coalesce(paid_at, created_at)) = p_business_date
  )
  select coalesce(jsonb_object_agg(method, cents), '{}'::jsonb) into v_mix
    from (select p.method, sum(p.amount_cents - p.refunded_cents)::bigint as cents
            from public.payments p join o on o.id = p.order_id
           where p.status <> 'voided' group by p.method) x;

  select jsonb_build_object('count', count(*), 'cents', coalesce(sum(amount_cents), 0)) into v_exp
    from public.expenses where expense_date = p_business_date and status in ('approved', 'paid');
  select jsonb_build_object('count', count(*), 'cents', coalesce(sum(amount_cents), 0)) into v_supp
    from public.supplier_payments where app.business_day(paid_at) = p_business_date;
  select to_jsonb(c) - 'counted_by' into v_count from public.cash_counts c
   where c.business_date = p_business_date order by c.created_at desc limit 1;

  select count(*) into v_open_orders from public.orders
   where status in ('pending', 'in_kitchen', 'ready') and app.business_day(created_at) = p_business_date;
  select jsonb_build_object('count', count(*), 'cents', coalesce(sum(due), 0)) into v_unpaid
    from (select o.total_cents - coalesce((select sum(p.amount_cents - p.refunded_cents) from public.payments p
                                            where p.order_id = o.id and p.status <> 'voided'), 0) as due
            from public.orders o
           where o.status = 'served' and app.business_day(coalesce(o.paid_at, o.created_at)) = p_business_date) u
   where due > 0;
  select count(*) into v_awaiting from public.expenses where expense_date = p_business_date and status in ('draft', 'submitted');
  select count(*) into v_holds from public.supplier_payment_holds where status = 'open';
  select * into v_closing from public.daily_closings where business_date = p_business_date;

  return jsonb_build_object(
    'business_date', p_business_date,
    'status', coalesce(v_closing.status, 'open'),
    'is_future', p_business_date > app.business_day(now()),
    'sales', v_s || jsonb_build_object('tax_cents', v_tax),
    'payments_by_method', v_mix,
    'cash', jsonb_build_object(
      'opening_cents', coalesce(p_opening_cents, 0),
      'cash_sales_cents', coalesce((v_s->>'cash_in_cents')::int, 0),
      'movements_cents', v_mov,
      'expected_cents', coalesce(p_opening_cents, 0) + coalesce((v_s->>'cash_in_cents')::int, 0) + v_mov,
      'last_count', v_count),
    'expenses', v_exp,
    'supplier_payments', v_supp,
    'exceptions', jsonb_build_object(
      'open_orders', v_open_orders,
      'unpaid_served_orders', v_unpaid,
      'expenses_awaiting_approval', v_awaiting,
      'invoice_holds_open', v_holds)
  );
end $fn$;
revoke all on function public.day_close_preview(date, int) from public;
grant execute on function public.day_close_preview(date, int) to authenticated, service_role;

-- ── 4. Close / reopen ───────────────────────────────────────────────────────
create or replace function public.close_business_day(
  p_business_date date, p_opening_cash int default 0,
  p_closing_cash int default null, p_note text default null
) returns public.daily_closings
language plpgsql security definer set search_path = public, app as $fn$
declare v_p jsonb; v_s jsonb; v_mov int; v_expected int; v_diff int; v_row public.daily_closings;
begin
  if not app.has_perm('finance.close_day') then
    raise exception 'forbidden' using errcode = 'insufficient_privilege';
  end if;
  if p_business_date > app.business_day(now()) then
    raise exception 'future_day: % has not happened yet', p_business_date using errcode = 'check_violation';
  end if;
  if app.is_day_closed(p_business_date) then
    raise exception 'already_closed: reopen % first', p_business_date using errcode = 'check_violation';
  end if;
  if coalesce(p_opening_cash, 0) < 0 or coalesce(p_closing_cash, 0) < 0 then
    raise exception 'bad_amount' using errcode = 'check_violation';
  end if;

  v_p := public.day_close_preview(p_business_date, coalesce(p_opening_cash, 0));
  v_s := app.day_sales(p_business_date);
  v_mov := app.day_cash_movements(p_business_date);
  v_expected := coalesce(p_opening_cash, 0) + (v_s->>'cash_in_cents')::int + v_mov;
  v_diff := case when p_closing_cash is null then null else p_closing_cash - v_expected end;
  if v_diff is not null and v_diff <> 0 and coalesce(trim(p_note), '') = '' then
    raise exception 'variance_reason_required: counted cash differs from expected by %', v_diff using errcode = 'check_violation';
  end if;

  insert into public.daily_closings (
    business_date, status, opening_cash_cents, closing_cash_cents, expected_cash_cents,
    difference_cents, gross_sales_cents, discounts_cents, refunds_cents, net_sales_cents,
    order_count, cash_movements_cents, summary, note, closed_by, closed_at
  ) values (
    p_business_date, 'closed', coalesce(p_opening_cash, 0), p_closing_cash, v_expected, v_diff,
    (v_s->>'gross_sales_cents')::int, (v_s->>'discounts_cents')::int, (v_s->>'refunds_cents')::int,
    (v_s->>'net_sales_cents')::int, (v_s->>'order_count')::int, v_mov, v_p,
    nullif(trim(p_note), ''), app.jwt_sub(), now()
  )
  on conflict (business_date) do update set
    status = 'closed', opening_cash_cents = excluded.opening_cash_cents,
    closing_cash_cents = excluded.closing_cash_cents, expected_cash_cents = excluded.expected_cash_cents,
    difference_cents = excluded.difference_cents, gross_sales_cents = excluded.gross_sales_cents,
    discounts_cents = excluded.discounts_cents, refunds_cents = excluded.refunds_cents,
    net_sales_cents = excluded.net_sales_cents, order_count = excluded.order_count,
    cash_movements_cents = excluded.cash_movements_cents, summary = excluded.summary,
    note = coalesce(excluded.note, public.daily_closings.note),
    closed_by = excluded.closed_by, closed_at = now()
  returning * into v_row;

  perform app.log_action('day.closed', 'daily_closings', p_business_date::text, null,
    to_jsonb(v_row) - 'summary');
  return v_row;
end $fn$;
revoke all on function public.close_business_day(date, int, int, text) from public;
grant execute on function public.close_business_day(date, int, int, text) to authenticated, service_role;

create or replace function public.reopen_business_day(p_business_date date, p_reason text)
returns void language plpgsql security definer set search_path = public, app as $fn$
begin
  if not app.has_perm('finance.reopen_day') then
    raise exception 'forbidden' using errcode = 'insufficient_privilege';
  end if;
  if coalesce(trim(p_reason), '') = '' then raise exception 'reason_required' using errcode = 'check_violation'; end if;
  update public.daily_closings
     set status = 'open', reopened_by = app.jwt_sub(), reopened_at = now(),
         note = trim(p_reason)
   where business_date = p_business_date and status = 'closed';
  if not found then raise exception 'not_closed' using errcode = 'no_data_found'; end if;
  perform app.log_action('day.reopened', 'daily_closings', p_business_date::text, null,
                         jsonb_build_object('reason', trim(p_reason)));
end $fn$;
revoke all on function public.reopen_business_day(date, text) from public;
grant execute on function public.reopen_business_day(date, text) to authenticated, service_role;

-- ── 5. Closed days are locked ───────────────────────────────────────────────
create or replace function app.guard_closed_day() returns trigger
language plpgsql set search_path = public, app as $fn$
declare v_day date;
begin
  case tg_table_name
  when 'expenses' then
    if tg_op = 'INSERT' and app.is_day_closed(new.expense_date) then v_day := new.expense_date;
    elsif tg_op = 'DELETE' and app.is_day_closed(old.expense_date) then v_day := old.expense_date;
    elsif tg_op = 'UPDATE'
      and (new.category, new.description, new.amount_cents, new.expense_date, new.supplier_id, new.vendor)
          is distinct from (old.category, old.description, old.amount_cents, old.expense_date, old.supplier_id, old.vendor) then
      if app.is_day_closed(old.expense_date) then v_day := old.expense_date;
      elsif app.is_day_closed(new.expense_date) then v_day := new.expense_date; end if;
    end if;
  when 'cash_counts' then
    if app.is_day_closed(new.business_date) then v_day := new.business_date; end if;
  when 'cash_movements' then
    if app.is_day_closed(new.business_date) then v_day := new.business_date; end if;
  when 'payments' then
    if tg_op = 'INSERT' then
      if app.is_day_closed(app.business_day(new.created_at)) then v_day := app.business_day(new.created_at); end if;
    elsif tg_op = 'DELETE' then
      if app.is_day_closed(app.business_day(old.created_at)) then v_day := app.business_day(old.created_at); end if;
    elsif (new.amount_cents is distinct from old.amount_cents
           or (new.status = 'voided' and old.status is distinct from 'voided'))
          and app.is_day_closed(app.business_day(old.created_at)) then
      v_day := app.business_day(old.created_at);
    end if;
  when 'orders' then
    if tg_op = 'DELETE' then
      if old.status in ('served', 'paid') and app.is_day_closed(app.business_day(coalesce(old.paid_at, old.created_at))) then
        v_day := app.business_day(coalesce(old.paid_at, old.created_at));
      end if;
    elsif old.status in ('served', 'paid')
          and (new.status = 'void' or new.subtotal_cents is distinct from old.subtotal_cents
               or new.discount_cents is distinct from old.discount_cents or new.total_cents is distinct from old.total_cents)
          and app.is_day_closed(app.business_day(coalesce(old.paid_at, old.created_at))) then
      v_day := app.business_day(coalesce(old.paid_at, old.created_at));
    end if;
  end case;
  if v_day is not null then
    raise exception 'day_closed: % is closed', v_day using errcode = 'insufficient_privilege',
      hint = 'Reopen the day with a reason, or record the correction on an open day (a refund is always allowed).';
  end if;
  return coalesce(new, old);
end $fn$;

do $$
declare t text;
begin
  foreach t in array array['expenses', 'cash_counts', 'cash_movements', 'payments', 'orders'] loop
    execute format('drop trigger if exists guard_closed_day on public.%I', t);
    execute format(
      'create trigger guard_closed_day before insert or update or delete on public.%I for each row execute function app.guard_closed_day()', t);
  end loop;
end $$;
