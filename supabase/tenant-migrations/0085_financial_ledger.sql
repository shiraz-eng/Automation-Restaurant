-- ============================================================================
-- 0085_financial_ledger.sql — Finance Phase B (financial ledger)
--
-- public.financial_events is an append-only journal of every money event,
-- written ONLY by triggers on the source tables (and one permission-checked
-- manual-adjustment function). Nothing in it is ever updated or deleted:
-- a change to a source row is recorded as a new adjustment/reversal event.
--
-- Each event has a category and a sign (+1 increases that category's
-- balance, -1 decreases it, 0 = informational):
--   revenue   net sales = subtotal - discount - refunds of served/paid orders
--   cogs      recipe cost snapshot on the order lines of those orders
--             (exactly what period_profitability() reports as COGS)
--   payment   customer money held = payment amount - refunds, 0 if voided
--   expense   operating expenses
--   payable   approved supplier invoices (+), supplier payments and credit notes (-)
--   inventory goods received (+) and stock adjustments (±) at cost
--   waste     spoilage at cost
--   cash / close / purchasing   informational (sign 0)
--
-- Revenue, COGS, payments, expenses and invoices are kept in step with their
-- source by "sync" functions: they compare what the source says now with the
-- ledger balance for that source row and post only the difference, so the
-- ledger always converges to the source and every step stays traceable.
-- Raw order stock deductions are NOT posted (they are the same cost as the
-- recipe snapshot and would double-count COGS).
-- ============================================================================

create table if not exists public.financial_events (
  id             bigint generated always as identity primary key,
  event_type     text not null,
  category       text not null check (category in
                   ('revenue','cogs','payment','expense','payable','inventory','waste','cash','close','purchasing','adjustment')),
  sign           smallint not null check (sign in (-1, 0, 1)),
  amount_cents   bigint not null check (amount_cents >= 0),
  signed_cents   bigint generated always as (sign * amount_cents) stored,
  currency       text not null,
  occurred_at    timestamptz not null,
  business_date  date not null,
  source_table   text not null,
  source_id      uuid,
  order_id       uuid,
  supplier_id    uuid,
  payment_method text,
  actor_id       uuid,
  actor_role     text,
  portal_id      uuid,
  details        jsonb not null default '{}'::jsonb,
  created_at     timestamptz not null default now()
);
create index if not exists financial_events_cat_date_idx on public.financial_events (category, business_date);
create index if not exists financial_events_source_idx on public.financial_events (source_table, source_id);
create index if not exists financial_events_order_idx on public.financial_events (order_id) where order_id is not null;
create index if not exists financial_events_date_idx on public.financial_events (business_date desc, id desc);

alter table public.financial_events enable row level security;
drop policy if exists finance_read on public.financial_events;
create policy finance_read on public.financial_events for select using (
  app.has_perm('finance.view') or app.has_perm('finance.view_profit') or app.can_write());
revoke insert, update, delete, truncate on public.financial_events from anon, authenticated;

-- Immutable: no update / delete / truncate, for anyone.
create or replace function app.ledger_immutable() returns trigger
language plpgsql as $fn$
begin
  raise exception 'ledger_immutable' using errcode = 'insufficient_privilege',
    hint = 'Financial events are never changed; post an adjustment instead.';
end $fn$;
drop trigger if exists ledger_no_update on public.financial_events;
create trigger ledger_no_update before update or delete on public.financial_events
  for each row execute function app.ledger_immutable();
drop trigger if exists ledger_no_truncate on public.financial_events;
create trigger ledger_no_truncate before truncate on public.financial_events
  for each statement execute function app.ledger_immutable();

-- ── Posting ─────────────────────────────────────────────────────────────────
create or replace function app.ledger_post(
  p_type text, p_category text, p_sign smallint, p_amount bigint, p_at timestamptz,
  p_source_table text, p_source_id uuid,
  p_business_date date default null, p_order_id uuid default null, p_supplier_id uuid default null,
  p_method text default null, p_details jsonb default '{}'::jsonb
) returns void
language plpgsql security definer set search_path = public, app as $fn$
declare v_at timestamptz := coalesce(p_at, now());
begin
  if p_amount = 0 and p_sign <> 0 then return; end if;
  insert into public.financial_events (
    event_type, category, sign, amount_cents, currency, occurred_at, business_date,
    source_table, source_id, order_id, supplier_id, payment_method,
    actor_id, actor_role, portal_id, details
  ) values (
    p_type, p_category, p_sign, abs(p_amount),
    coalesce((select currency_code from public.business_settings limit 1), 'USD'),
    v_at,
    coalesce(p_business_date, app.business_day(v_at), (v_at at time zone 'UTC')::date),
    p_source_table, p_source_id, p_order_id, p_supplier_id, p_method,
    app.jwt_sub(), app.current_member_role(), app.current_portal_id(),
    coalesce(p_details, '{}'::jsonb)
  );
end $fn$;
revoke all on function app.ledger_post(text, text, smallint, bigint, timestamptz, text, uuid, date, uuid, uuid, text, jsonb) from public;

-- Revenue + COGS for one order, posted as the difference from the ledger.
create or replace function app.ledger_sync_order(p_order_id uuid, p_cause text default 'update', p_at timestamptz default null)
returns void language plpgsql security definer set search_path = public, app as $fn$
declare
  o public.orders; v_done boolean := false;
  v_rev bigint := 0; v_cogs bigint := 0; v_missing int := 0;
  v_rev_bal bigint; v_cogs_bal bigint; v_delta bigint; v_type text; v_at timestamptz;
begin
  select * into o from public.orders where id = p_order_id;
  v_done := found and o.status in ('served', 'paid');
  select coalesce(sum(signed_cents) filter (where category = 'revenue'), 0),
         coalesce(sum(signed_cents) filter (where category = 'cogs'), 0)
    into v_rev_bal, v_cogs_bal
    from public.financial_events where order_id = p_order_id;
  if not v_done and v_rev_bal = 0 and v_cogs_bal = 0 then return; end if;

  if v_done then
    v_rev := o.subtotal_cents - o.discount_cents - o.refunded_cents;
    select coalesce(sum(recipe_cost_cents), 0), count(*) filter (where recipe_cost_cents is null)
      into v_cogs, v_missing from public.order_lines where order_id = p_order_id;
  end if;
  v_at := coalesce(p_at, now());

  v_delta := v_rev - v_rev_bal;
  if v_delta <> 0 then
    v_type := case when not v_done then 'ORDER_REVERSED'
                   when v_rev_bal = 0 then 'ORDER_COMPLETED'
                   when p_cause = 'refund' then 'REVENUE_REFUNDED'
                   else 'ORDER_ADJUSTED' end;
    perform app.ledger_post(v_type, 'revenue', sign(v_delta)::smallint, v_delta, v_at, 'orders', p_order_id,
      null, p_order_id, null, o.payment_method,
      jsonb_build_object('order_number', o.order_number, 'status', o.status, 'channel', o.channel,
        'gross_cents', o.subtotal_cents, 'discount_cents', o.discount_cents, 'refunded_cents', o.refunded_cents,
        'tax_cents', o.tax_cents, 'total_cents', o.total_cents, 'cause', p_cause));
  end if;

  v_delta := v_cogs - v_cogs_bal;
  if v_delta <> 0 then
    v_type := case when not v_done then 'COGS_REVERSED' when v_cogs_bal = 0 then 'COGS_RECORDED' else 'COGS_ADJUSTED' end;
    perform app.ledger_post(v_type, 'cogs', sign(v_delta)::smallint, v_delta, v_at, 'orders', p_order_id,
      null, p_order_id, null, null,
      jsonb_build_object('order_number', o.order_number, 'lines_missing_recipe', v_missing));
  end if;
end $fn$;
revoke all on function app.ledger_sync_order(uuid, text, timestamptz) from public;

-- Customer money held for one payment.
create or replace function app.ledger_sync_payment(p_payment_id uuid, p_cause text default 'update', p_at timestamptz default null)
returns void language plpgsql security definer set search_path = public, app as $fn$
declare p public.payments; v_target bigint := 0; v_bal bigint; v_n int; v_delta bigint; v_type text;
begin
  select * into p from public.payments where id = p_payment_id;
  select coalesce(sum(signed_cents), 0), count(*) into v_bal, v_n
    from public.financial_events where source_table = 'payments' and source_id = p_payment_id;
  if found and p.id is not null and v_n = 0 then
    perform app.ledger_post('PAYMENT_RECEIVED', 'payment', 1::smallint, p.amount_cents, coalesce(p_at, p.created_at),
      'payments', p.id, null, p.order_id, null, p.method,
      jsonb_build_object('reference', p.reference, 'tendered_cents', p.tendered_cents, 'change_cents', p.change_cents));
    v_bal := p.amount_cents;
  end if;
  if p.id is not null and p.status <> 'voided' then v_target := p.amount_cents - p.refunded_cents; end if;
  v_delta := v_target - v_bal;
  if v_delta = 0 then return; end if;
  v_type := case when p.id is null then 'PAYMENT_REMOVED'
                 when p.status = 'voided' then 'PAYMENT_VOIDED'
                 when p_cause = 'refund' then 'REFUND_ISSUED'
                 else 'PAYMENT_ADJUSTED' end;
  perform app.ledger_post(v_type, 'payment', sign(v_delta)::smallint, v_delta, coalesce(p_at, now()),
    'payments', p_payment_id, null, p.order_id, null, p.method,
    jsonb_build_object('status', p.status, 'refunded_cents', p.refunded_cents));
end $fn$;
revoke all on function app.ledger_sync_payment(uuid, text, timestamptz) from public;

-- ── Source triggers ─────────────────────────────────────────────────────────
create or replace function app.ledger_on_order() returns trigger
language plpgsql security definer set search_path = public, app as $fn$
begin
  if tg_op = 'DELETE' then
    perform app.ledger_sync_order(old.id, 'deleted');
  elsif tg_op = 'INSERT'
     or new.status is distinct from old.status or new.subtotal_cents is distinct from old.subtotal_cents
     or new.discount_cents is distinct from old.discount_cents or new.refunded_cents is distinct from old.refunded_cents then
    perform app.ledger_sync_order(new.id,
      case when tg_op = 'UPDATE' and new.refunded_cents is distinct from old.refunded_cents
                and new.status = old.status and new.subtotal_cents = old.subtotal_cents
                and new.discount_cents = old.discount_cents then 'refund'
           else lower(tg_op) end);
  end if;
  return null;
end $fn$;
drop trigger if exists ledger_sync on public.orders;
create trigger ledger_sync after insert or update or delete on public.orders
  for each row execute function app.ledger_on_order();

create or replace function app.ledger_on_order_line() returns trigger
language plpgsql security definer set search_path = public, app as $fn$
begin
  perform app.ledger_sync_order(coalesce(new.order_id, old.order_id), 'lines');
  if tg_op = 'UPDATE' and new.order_id is distinct from old.order_id then
    perform app.ledger_sync_order(old.order_id, 'lines');
  end if;
  return null;
end $fn$;
drop trigger if exists ledger_sync on public.order_lines;
create trigger ledger_sync after insert or delete or update of recipe_cost_cents, order_id on public.order_lines
  for each row execute function app.ledger_on_order_line();

create or replace function app.ledger_on_payment() returns trigger
language plpgsql security definer set search_path = public, app as $fn$
begin
  perform app.ledger_sync_payment(coalesce(new.id, old.id),
    case when tg_op = 'UPDATE' and new.refunded_cents is distinct from old.refunded_cents
              and new.status is not distinct from old.status then 'refund' else lower(tg_op) end);
  return null;
end $fn$;
drop trigger if exists ledger_sync on public.payments;
create trigger ledger_sync after insert or delete or update of amount_cents, refunded_cents, status on public.payments
  for each row execute function app.ledger_on_payment();

create or replace function app.ledger_on_expense() returns trigger
language plpgsql security definer set search_path = public, app as $fn$
declare v_bal bigint;
begin
  if tg_op = 'INSERT' then
    perform app.ledger_post('EXPENSE_RECORDED', 'expense', 1::smallint, new.amount_cents, now(), 'expenses', new.id,
      new.expense_date, null, new.supplier_id, null,
      jsonb_build_object('category', new.category, 'description', new.description));
    return null;
  end if;
  select coalesce(sum(signed_cents), 0) into v_bal
    from public.financial_events where source_table = 'expenses' and source_id = old.id;
  if tg_op = 'DELETE' then
    perform app.ledger_post('EXPENSE_REVERSED', 'expense', (-1)::smallint, v_bal, now(), 'expenses', old.id,
      old.expense_date, null, old.supplier_id, null,
      jsonb_build_object('category', old.category, 'description', old.description));
  elsif new.expense_date is distinct from old.expense_date then
    perform app.ledger_post('EXPENSE_REVERSED', 'expense', (-1)::smallint, v_bal, now(), 'expenses', old.id,
      old.expense_date, null, old.supplier_id, null, jsonb_build_object('cause', 'date_changed', 'new_date', new.expense_date));
    perform app.ledger_post('EXPENSE_RECORDED', 'expense', 1::smallint, new.amount_cents, now(), 'expenses', new.id,
      new.expense_date, null, new.supplier_id, null,
      jsonb_build_object('category', new.category, 'description', new.description, 'cause', 'date_changed'));
  elsif new.amount_cents <> v_bal then
    perform app.ledger_post('EXPENSE_ADJUSTED', 'expense', sign(new.amount_cents - v_bal)::smallint,
      new.amount_cents - v_bal, now(), 'expenses', new.id, new.expense_date, null, new.supplier_id, null,
      jsonb_build_object('from_cents', v_bal, 'to_cents', new.amount_cents));
  end if;
  return null;
end $fn$;
drop trigger if exists ledger_sync on public.expenses;
create trigger ledger_sync after insert or update or delete on public.expenses
  for each row execute function app.ledger_on_expense();

create or replace function app.ledger_on_supplier_invoice() returns trigger
language plpgsql security definer set search_path = public, app as $fn$
declare v_target bigint := 0; v_bal bigint;
begin
  if new.status in ('approved', 'partially_paid', 'paid') then v_target := new.total_cents; end if;
  select coalesce(sum(signed_cents), 0) into v_bal
    from public.financial_events where source_table = 'supplier_invoices' and source_id = new.id;
  if v_target <> v_bal then
    perform app.ledger_post(case when v_target > v_bal then 'SUPPLIER_INVOICE_APPROVED' else 'SUPPLIER_INVOICE_REVERSED' end,
      'payable', sign(v_target - v_bal)::smallint, v_target - v_bal, coalesce(new.approved_at, now()),
      'supplier_invoices', new.id, null, null, new.supplier_id, null,
      jsonb_build_object('invoice_number', new.supplier_invoice_number, 'invoice_ref', new.invoice_ref,
        'status', new.status, 'due_date', new.due_date, 'purchase_order_id', new.purchase_order_id));
  end if;
  return null;
end $fn$;
drop trigger if exists ledger_sync on public.supplier_invoices;
create trigger ledger_sync after insert or update of status, total_cents on public.supplier_invoices
  for each row execute function app.ledger_on_supplier_invoice();

create or replace function app.ledger_on_simple() returns trigger
language plpgsql security definer set search_path = public, app as $fn$
begin
  case tg_table_name
  when 'supplier_payments' then
    perform app.ledger_post('SUPPLIER_PAYMENT_MADE', 'payable', (-1)::smallint, new.amount_cents, new.paid_at,
      'supplier_payments', new.id, null, null, new.supplier_id, new.method,
      jsonb_build_object('reference', new.reference, 'note', new.note));
  when 'supplier_credit_notes' then
    perform app.ledger_post('SUPPLIER_CREDIT_NOTE', 'payable', (-1)::smallint, new.amount_cents, now(),
      'supplier_credit_notes', new.id, new.credit_date, null, new.supplier_id, null,
      jsonb_build_object('reason', new.reason, 'invoice_id', new.invoice_id));
  when 'cash_counts' then
    perform app.ledger_post('CASH_COUNTED', 'cash', 0::smallint, new.counted_cents, new.created_at,
      'cash_counts', new.id, new.business_date, null, null, 'cash',
      jsonb_build_object('opening_cents', new.opening_cents, 'expected_cents', new.expected_cents,
        'difference_cents', new.difference_cents, 'note', new.note));
  when 'stock_ledger' then
    if new.reason <> 'order_deduction' then
      perform app.ledger_post(
        case new.reason when 'restock' then 'GOODS_RECEIVED' when 'spoilage' then 'WASTE_RECORDED' else 'STOCK_ADJUSTED' end,
        case new.reason when 'spoilage' then 'waste' else 'inventory' end,
        case when new.reason = 'spoilage' then 1 else sign(new.delta_qty) end::smallint,
        round(abs(new.delta_qty) * coalesce(new.unit_cost_cents_base,
          (select cost_cents_per_base_unit from public.inventory_items where id = new.inventory_item_id), 0))::bigint,
        new.created_at, 'stock_ledger', new.id, null, new.order_id, null, null,
        jsonb_build_object('inventory_item_id', new.inventory_item_id, 'qty', new.delta_qty,
          'reason', new.reason, 'note', new.note, 'cost_estimated', new.unit_cost_cents_base is null));
    end if;
  end case;
  return null;
end $fn$;
do $$
declare t text;
begin
  foreach t in array array['supplier_payments', 'supplier_credit_notes', 'cash_counts', 'stock_ledger'] loop
    execute format('drop trigger if exists ledger_sync on public.%I', t);
    execute format('create trigger ledger_sync after insert on public.%I for each row execute function app.ledger_on_simple()', t);
  end loop;
end $$;

create or replace function app.ledger_on_close() returns trigger
language plpgsql security definer set search_path = public, app as $fn$
begin
  if new.status = 'closed' and (tg_op = 'INSERT' or old.status is distinct from 'closed' or new.closed_at is distinct from old.closed_at) then
    perform app.ledger_post('BUSINESS_DAY_CLOSED', 'close', 0::smallint, new.net_sales_cents, coalesce(new.closed_at, now()),
      'daily_closings', new.id, new.business_date, null, null, null,
      jsonb_build_object('gross_sales_cents', new.gross_sales_cents, 'expected_cash_cents', new.expected_cash_cents,
        'closing_cash_cents', new.closing_cash_cents, 'difference_cents', new.difference_cents, 'order_count', new.order_count));
  elsif tg_op = 'UPDATE' and new.status = 'open' and old.status = 'closed' then
    perform app.ledger_post('BUSINESS_DAY_REOPENED', 'close', 0::smallint, 0, coalesce(new.reopened_at, now()),
      'daily_closings', new.id, new.business_date, null, null, null, jsonb_build_object('reason', new.note));
  end if;
  return null;
end $fn$;
drop trigger if exists ledger_sync on public.daily_closings;
create trigger ledger_sync after insert or update on public.daily_closings
  for each row execute function app.ledger_on_close();

create or replace function app.ledger_on_purchase_order() returns trigger
language plpgsql security definer set search_path = public, app as $fn$
begin
  if new.approved_at is not null and (tg_op = 'INSERT' or old.approved_at is null) then
    perform app.ledger_post('PURCHASE_ORDER_APPROVED', 'purchasing', 0::smallint, new.subtotal_cents, new.approved_at,
      'purchase_orders', new.id, null, null, new.supplier_id, null,
      jsonb_build_object('po_number', new.po_number, 'expected_at', new.expected_at));
  end if;
  return null;
end $fn$;
drop trigger if exists ledger_sync on public.purchase_orders;
create trigger ledger_sync after insert or update of approved_at on public.purchase_orders
  for each row execute function app.ledger_on_purchase_order();

-- ── Controlled manual adjustment ────────────────────────────────────────────
insert into public.permission_catalog (key, grp, label, type, risk_level) values
  ('finance.adjust_ledger', 'Finance', 'Post manual financial ledger adjustments', 'approval', 'high')
on conflict (key) do update set grp = excluded.grp, label = excluded.label,
  type = excluded.type, risk_level = excluded.risk_level;

create or replace function public.post_ledger_adjustment(
  p_category text, p_amount_cents bigint, p_reason text, p_business_date date default null
) returns bigint
language plpgsql security definer set search_path = public, app as $fn$
declare v_id bigint;
begin
  if not app.has_perm('finance.adjust_ledger') then
    raise exception 'forbidden' using errcode = 'insufficient_privilege';
  end if;
  if coalesce(trim(p_reason), '') = '' then raise exception 'reason_required' using errcode = 'check_violation'; end if;
  if coalesce(p_amount_cents, 0) = 0 then raise exception 'bad_amount' using errcode = 'check_violation'; end if;
  if p_category not in ('revenue','cogs','payment','expense','payable','inventory','waste','cash') then
    raise exception 'bad_category' using errcode = 'check_violation';
  end if;
  perform app.ledger_post('MANUAL_ADJUSTMENT', p_category, sign(p_amount_cents)::smallint, p_amount_cents, now(),
    'manual', null, p_business_date, null, null, null, jsonb_build_object('reason', trim(p_reason)));
  select max(id) into v_id from public.financial_events where event_type = 'MANUAL_ADJUSTMENT';
  perform app.log_action('ledger.adjusted', 'financial_events', v_id::text, null,
    jsonb_build_object('category', p_category, 'amount_cents', p_amount_cents, 'reason', p_reason, 'business_date', p_business_date));
  return v_id;
end $fn$;
revoke all on function public.post_ledger_adjustment(text, bigint, text, date) from public;
grant execute on function public.post_ledger_adjustment(text, bigint, text, date) to authenticated, service_role;

-- ── Reading (RLS applies: needs finance.view / view_profit or owner/manager) ─
create or replace function public.ledger_summary(p_from date, p_to date)
returns table (category text, net_cents bigint, increase_cents bigint, decrease_cents bigint, events bigint)
language sql stable security invoker set search_path = public, app as $fn$
  select e.category,
         sum(e.signed_cents)::bigint,
         coalesce(sum(e.amount_cents) filter (where e.sign = 1), 0)::bigint,
         coalesce(sum(e.amount_cents) filter (where e.sign = -1), 0)::bigint,
         count(*)::bigint
    from public.financial_events e
   where e.business_date between p_from and p_to
   group by e.category
   order by e.category
$fn$;
grant execute on function public.ledger_summary(date, date) to authenticated, service_role;

create or replace function public.ledger_events(
  p_from date, p_to date, p_category text default null, p_limit int default 200
) returns setof public.financial_events
language sql stable security invoker set search_path = public, app as $fn$
  select * from public.financial_events e
   where e.business_date between p_from and p_to
     and (p_category is null or e.category = p_category)
   order by e.occurred_at desc, e.id desc
   limit least(greatest(coalesce(p_limit, 200), 1), 1000)
$fn$;
grant execute on function public.ledger_events(date, date, text, int) to authenticated, service_role;

-- ── Backfill existing history (once, when the ledger is empty) ─────────────
do $$
declare r record;
begin
  if exists (select 1 from public.financial_events) then return; end if;

  for r in select id, coalesce(paid_at, created_at) as at from public.orders where status in ('served', 'paid') loop
    perform app.ledger_sync_order(r.id, 'backfill', r.at);
  end loop;
  for r in select id, created_at from public.payments loop
    perform app.ledger_sync_payment(r.id, 'backfill', r.created_at);
  end loop;
  insert into public.financial_events (event_type, category, sign, amount_cents, currency, occurred_at, business_date,
      source_table, source_id, supplier_id, actor_id, details)
    select 'EXPENSE_RECORDED', 'expense', 1, e.amount_cents,
           coalesce((select currency_code from public.business_settings limit 1), 'USD'),
           e.created_at, e.expense_date, 'expenses', e.id, e.supplier_id, e.recorded_by,
           jsonb_build_object('category', e.category, 'description', e.description, 'backfill', true)
      from public.expenses e;
  insert into public.financial_events (event_type, category, sign, amount_cents, currency, occurred_at, business_date,
      source_table, source_id, supplier_id, actor_id, details)
    select 'SUPPLIER_INVOICE_APPROVED', 'payable', 1, i.total_cents,
           coalesce((select currency_code from public.business_settings limit 1), 'USD'),
           coalesce(i.approved_at, i.created_at),
           coalesce(app.business_day(coalesce(i.approved_at, i.created_at)), i.invoice_date),
           'supplier_invoices', i.id, i.supplier_id, i.approved_by,
           jsonb_build_object('invoice_number', i.supplier_invoice_number, 'status', i.status, 'backfill', true)
      from public.supplier_invoices i
     where i.status in ('approved', 'partially_paid', 'paid') and i.total_cents > 0;
  insert into public.financial_events (event_type, category, sign, amount_cents, currency, occurred_at, business_date,
      source_table, source_id, supplier_id, payment_method, actor_id, details)
    select 'SUPPLIER_PAYMENT_MADE', 'payable', -1, p.amount_cents,
           coalesce((select currency_code from public.business_settings limit 1), 'USD'),
           p.paid_at, coalesce(app.business_day(p.paid_at), p.paid_at::date),
           'supplier_payments', p.id, p.supplier_id, p.method, p.created_by,
           jsonb_build_object('reference', p.reference, 'backfill', true)
      from public.supplier_payments p;
  insert into public.financial_events (event_type, category, sign, amount_cents, currency, occurred_at, business_date,
      source_table, source_id, supplier_id, actor_id, details)
    select 'SUPPLIER_CREDIT_NOTE', 'payable', -1, c.amount_cents,
           coalesce((select currency_code from public.business_settings limit 1), 'USD'),
           c.created_at, c.credit_date, 'supplier_credit_notes', c.id, c.supplier_id, c.created_by,
           jsonb_build_object('reason', c.reason, 'backfill', true)
      from public.supplier_credit_notes c;
  insert into public.financial_events (event_type, category, sign, amount_cents, currency, occurred_at, business_date,
      source_table, source_id, order_id, details)
    select case s.reason when 'restock' then 'GOODS_RECEIVED' when 'spoilage' then 'WASTE_RECORDED' else 'STOCK_ADJUSTED' end,
           case s.reason when 'spoilage' then 'waste' else 'inventory' end,
           case when s.reason = 'spoilage' then 1 else sign(s.delta_qty) end,
           round(abs(s.delta_qty) * coalesce(s.unit_cost_cents_base, ii.cost_cents_per_base_unit, 0))::bigint,
           coalesce((select currency_code from public.business_settings limit 1), 'USD'),
           s.created_at, coalesce(app.business_day(s.created_at), s.created_at::date),
           'stock_ledger', s.id, s.order_id,
           jsonb_build_object('inventory_item_id', s.inventory_item_id, 'qty', s.delta_qty, 'reason', s.reason,
             'cost_estimated', s.unit_cost_cents_base is null, 'backfill', true)
      from public.stock_ledger s left join public.inventory_items ii on ii.id = s.inventory_item_id
     where s.reason <> 'order_deduction' and s.delta_qty <> 0;
  insert into public.financial_events (event_type, category, sign, amount_cents, currency, occurred_at, business_date,
      source_table, source_id, payment_method, actor_id, details)
    select 'CASH_COUNTED', 'cash', 0, c.counted_cents,
           coalesce((select currency_code from public.business_settings limit 1), 'USD'),
           c.created_at, c.business_date, 'cash_counts', c.id, 'cash', c.counted_by,
           jsonb_build_object('expected_cents', c.expected_cents, 'difference_cents', c.difference_cents, 'backfill', true)
      from public.cash_counts c;
  insert into public.financial_events (event_type, category, sign, amount_cents, currency, occurred_at, business_date,
      source_table, source_id, actor_id, details)
    select 'BUSINESS_DAY_CLOSED', 'close', 0, d.net_sales_cents,
           coalesce((select currency_code from public.business_settings limit 1), 'USD'),
           coalesce(d.closed_at, d.created_at), d.business_date, 'daily_closings', d.id, d.closed_by,
           jsonb_build_object('difference_cents', d.difference_cents, 'backfill', true)
      from public.daily_closings d where d.status = 'closed';
  insert into public.financial_events (event_type, category, sign, amount_cents, currency, occurred_at, business_date,
      source_table, source_id, supplier_id, actor_id, details)
    select 'PURCHASE_ORDER_APPROVED', 'purchasing', 0, po.subtotal_cents,
           coalesce((select currency_code from public.business_settings limit 1), 'USD'),
           po.approved_at, coalesce(app.business_day(po.approved_at), po.approved_at::date),
           'purchase_orders', po.id, po.supplier_id, po.approved_by,
           jsonb_build_object('po_number', po.po_number, 'backfill', true)
      from public.purchase_orders po where po.approved_at is not null;
end $$;
