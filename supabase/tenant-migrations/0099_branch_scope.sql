-- ============================================================================
-- 0099 — Multi-branch, phase 2-3 (database side): the selected branch.
--
-- The app sends the branch(es) the user is looking at in the `x-branch-ids`
-- request header (PostgREST exposes request headers to SQL). It is a VIEW
-- choice, never a permission: every use is intersected with the branches the
-- login may use (app.branch_access, 0098). No header = all permitted branches.
--
--   • Reads: the branch walls now also narrow to the selected branch(es), and
--     the read-only reporting functions (which run as definer and so bypass
--     RLS) read through branch-scoped views — every screen, report and RPC is
--     scoped the same way, with no signature changes.
--   • Writes: a new row without a branch takes its parent's, else the
--     selected branch, else the default. A row may only be changed by a login
--     allowed in its branch, whichever function makes the change.
--   • Day close is per branch: its own cash, preview, close and reopen.
-- ============================================================================

-- ── 1. The selected branch(es) ──────────────────────────────────────────────
create or replace function app.selected_branch_ids() returns uuid[]
language plpgsql stable set search_path = public, app as $fn$
declare
  raw text := nullif(trim(coalesce(nullif(current_setting('request.headers', true), '')::json ->> 'x-branch-ids', '')), '');
  v uuid[];
begin
  if raw is null then return null; end if;
  select array_agg(x::uuid) into v
    from unnest(string_to_array(raw, ',')) x
   where trim(x) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
  return v;   -- null when nothing valid was sent
end $fn$;

-- In scope = the login may use the branch AND it is one of the selected ones.
-- Organization-wide ledger lines (no branch: supplier payments, credit notes,
-- manual corrections) show only when no single branch is selected.
create or replace function app.in_scope(p_branch uuid) returns boolean
language sql stable as $fn$
  select app.branch_access(p_branch)
     and ((select app.selected_branch_ids()) is null
          or (p_branch is not null and p_branch = any(cast((select app.selected_branch_ids()) as uuid[]))))
$fn$;

-- The branch a new record belongs to when nothing more specific applies.
create or replace function app.request_branch_id() returns uuid
language plpgsql stable security definer set search_path = public, app as $fn$
declare v uuid; v_allowed uuid[] := app.allowed_branch_ids();
begin
  select b.id into v from public.branches b
   where b.id = any(coalesce(app.selected_branch_ids(), '{}')) and b.status = 'active'
     and (v_allowed is null or b.id = any(v_allowed))
   order by b.is_default desc, b.name limit 1;
  if v is not null then return v; end if;
  if v_allowed is null then return app.default_branch_id(); end if;
  select b.id into v from public.branches b
   where b.id = any(v_allowed) and b.status = 'active' order by b.is_default desc, b.name limit 1;
  return v;
end $fn$;

grant execute on function app.selected_branch_ids() to authenticated, anon, service_role;
grant execute on function app.in_scope(uuid) to authenticated, anon, service_role;
grant execute on function app.request_branch_id() to authenticated, anon, service_role;

-- ── 2. Branch walls narrow to the selection (writes still need access only) ─
do $mig$
declare t text;
begin
  foreach t in array array[
    'orders', 'payments', 'table_sessions', 'restaurant_tables', 'reservations', 'stock_ledger',
    'food_stock_log', 'low_stock_events', 'purchase_orders', 'supplier_invoices', 'daily_closings',
    'expenses', 'cash_counts', 'cash_movements', 'financial_events', 'shifts', 'attendance'
  ] loop
    if to_regclass('public.' || t) is null then continue; end if;
    execute format('drop policy if exists branch_wall on public.%I', t);
    execute format(
      'create policy branch_wall on public.%I as restrictive for all using (app.in_scope(branch_id)) with check (app.branch_access(branch_id))', t);
  end loop;
end $mig$;
drop policy if exists branch_wall on public.order_lines;
create policy branch_wall on public.order_lines as restrictive for all
  using (app.in_scope((select o.branch_id from public.orders o where o.id = order_id)))
  with check (app.branch_access((select o.branch_id from public.orders o where o.id = order_id)));
drop policy if exists branch_wall on public.refunds;
create policy branch_wall on public.refunds as restrictive for all
  using (app.in_scope((select p.branch_id from public.payments p where p.id = payment_id)))
  with check (app.branch_access((select p.branch_id from public.payments p where p.id = payment_id)));

-- ── 3. Branch on insert; branch access on every change ──────────────────────
create or replace function app.fill_branch_id() returns trigger
language plpgsql security definer set search_path = public, app as $fn$
begin
  if new.branch_id is null then
    case tg_table_name
      when 'payments' then
        select o.branch_id into new.branch_id from public.orders o where o.id = new.order_id;
      when 'orders' then
        if new.session_id is not null then
          select s.branch_id into new.branch_id from public.table_sessions s where s.id = new.session_id;
        end if;
      when 'supplier_invoices' then
        if new.purchase_order_id is not null then
          select po.branch_id into new.branch_id from public.purchase_orders po where po.id = new.purchase_order_id;
        end if;
      else null;
    end case;
    if new.branch_id is null then
      new.branch_id := coalesce(app.request_branch_id(), app.default_branch_id());
    end if;
  end if;
  -- Definer functions bypass RLS: the branch rule is enforced here for them too.
  if new.branch_id is not null and not app.branch_access(new.branch_id) then
    raise exception 'forbidden: this login cannot work in that branch' using errcode = 'insufficient_privilege';
  end if;
  if tg_table_name = 'orders' and not exists (select 1 from public.branches where id = new.branch_id and status = 'active') then
    raise exception 'branch_inactive: this branch is not taking orders' using errcode = 'check_violation';
  end if;
  return new;
end $fn$;

create or replace function app.guard_branch_change() returns trigger
language plpgsql security definer set search_path = public, app as $fn$
begin
  if not app.branch_access(old.branch_id) then
    raise exception 'forbidden: this record belongs to another branch' using errcode = 'insufficient_privilege';
  end if;
  if tg_op = 'UPDATE' and new.branch_id is distinct from old.branch_id and not app.branch_access(new.branch_id) then
    raise exception 'forbidden: this login cannot move records to that branch' using errcode = 'insufficient_privilege';
  end if;
  return coalesce(new, old);
end $fn$;

do $mig$
declare t text;
begin
  foreach t in array array[
    'orders', 'payments', 'table_sessions', 'restaurant_tables', 'reservations', 'stock_ledger',
    'food_stock_log', 'low_stock_events', 'purchase_orders', 'supplier_invoices', 'daily_closings',
    'expenses', 'cash_counts', 'cash_movements', 'shifts', 'attendance'
  ] loop
    if to_regclass('public.' || t) is null then continue; end if;
    execute format('drop trigger if exists fill_branch_id on public.%I', t);
    execute format('create trigger fill_branch_id before insert on public.%I for each row execute function app.fill_branch_id()', t);
    execute format('drop trigger if exists guard_branch_change on public.%I', t);
    execute format('create trigger guard_branch_change before update or delete on public.%I for each row execute function app.guard_branch_change()', t);
  end loop;
end $mig$;
-- Order lines follow their order.
create or replace function app.guard_branch_order_line() returns trigger
language plpgsql security definer set search_path = public, app as $fn$
declare v uuid;
begin
  select branch_id into v from public.orders where id = coalesce(new.order_id, old.order_id);
  if not app.branch_access(v) then
    raise exception 'forbidden: this order belongs to another branch' using errcode = 'insufficient_privilege';
  end if;
  return coalesce(new, old);
end $fn$;
drop trigger if exists guard_branch_change on public.order_lines;
create trigger guard_branch_change before insert or update or delete on public.order_lines
  for each row execute function app.guard_branch_order_line();

-- ── 4. Branch-scoped views for the read-only reporting functions ────────────
do $mig$
declare t text;
begin
  foreach t in array array[
    'orders', 'payments', 'expenses', 'financial_events', 'daily_closings', 'purchase_orders',
    'supplier_invoices', 'stock_ledger', 'cash_movements', 'cash_counts', 'reservations',
    'restaurant_tables', 'attendance', 'shifts', 'low_stock_events', 'food_stock_log', 'table_sessions'
  ] loop
    if to_regclass('public.' || t) is null then continue; end if;
    execute format('create or replace view app.%I with (security_barrier) as select * from public.%I where app.in_scope(branch_id)', 's_' || t, t);
  end loop;
end $mig$;

do $mig$
declare
  fn record;
  def text;
  pat constant text := 'public\.(orders|payments|expenses|financial_events|daily_closings|purchase_orders|supplier_invoices|stock_ledger|cash_movements|cash_counts|reservations|restaurant_tables|attendance|shifts|low_stock_events|food_stock_log|table_sessions)\M';
begin
  for fn in
    select p.oid from pg_proc p
     where p.pronamespace = 'public'::regnamespace and p.prokind = 'f'
       and p.proname in (
         'attendance_dashboard', 'attendance_history', 'attendance_month_summary', 'attendance_roster',
         'customer_stats', 'deal_performance', 'deal_performance_daily', 'deal_profitability', 'deal_sales',
         'item_profitability', 'order_profitability', 'orders_on_day', 'payables_aging', 'payment_mix',
         'payment_reconciliation', 'period_profitability', 'period_tax', 'promotion_performance',
         'revenue_by_category', 'sales_by_hour', 'sales_by_day', 'supplier_payable', 'supplier_statement',
         'supplier_invoice_history', 'feedback_summary', 'food_cost_watch')
  loop
    def := pg_get_functiondef(fn.oid);
    if def ~ pat then
      execute regexp_replace(def, pat, 'app.s_\1', 'g');
    end if;
  end loop;
end $mig$;

-- ── 5. Orders: a table's open tab is looked up within its branch ────────────
do $mig$
declare
  def text := pg_get_functiondef('public.place_order(text, text, text, integer, jsonb, integer, text, text)'::regprocedure);
  old_q constant text := 'where table_label = p_table_label and status = ''open''';
  new_q constant text := 'where table_label = p_table_label and status = ''open'' and branch_id = coalesce(app.request_branch_id(), app.default_branch_id())';
begin
  if position(old_q in def) > 0 then
    execute replace(def, old_q, new_q);
  elsif position(new_q in def) = 0 then
    raise exception '0099: unexpected table-session lookup in place_order()';
  end if;
end $mig$;

-- ── 6. Day close per branch ─────────────────────────────────────────────────
create or replace function app.day_sales(p_date date, p_branch uuid) returns jsonb
language sql stable set search_path = public, app as $fn$
  with o as (
    select * from public.orders
     where status in ('served','paid') and app.business_day(coalesce(paid_at, created_at)) = p_date
       and (p_branch is null or branch_id = p_branch)
  )
  select jsonb_build_object(
    'gross_sales_cents', coalesce((select sum(subtotal_cents) from o), 0),
    'discounts_cents',   coalesce((select sum(discount_cents) from o), 0),
    'refunds_cents',     coalesce((select sum(refunded_cents) from o), 0),
    'net_sales_cents',   coalesce((select sum(subtotal_cents - discount_cents - coalesce(refunded_cents,0)) from o), 0),
    'order_count',       (select count(*) from o),
    'cash_in_cents',     coalesce((select sum(p.amount_cents - p.refunded_cents)
                                   from public.payments p join o on o.id = p.order_id
                                   where p.status <> 'voided' and p.method = 'cash'), 0)
  )
$fn$;
-- The one-argument forms keep working: they mean "the branch being worked in".
create or replace function app.day_sales(p_date date) returns jsonb
language sql stable set search_path = public, app as $fn$
  select app.day_sales(p_date, coalesce(app.request_branch_id(), app.default_branch_id()))
$fn$;

create or replace function app.day_cash_movements(p_date date, p_branch uuid) returns integer
language sql stable set search_path = public, app as $fn$
  select coalesce(sum(signed_cents), 0)::int from public.cash_movements
   where business_date = p_date and (p_branch is null or branch_id = p_branch)
$fn$;
create or replace function app.day_cash_movements(p_date date) returns integer
language sql stable set search_path = public, app as $fn$
  select app.day_cash_movements(p_date, coalesce(app.request_branch_id(), app.default_branch_id()))
$fn$;

create or replace function app.is_day_closed(p_date date, p_branch uuid) returns boolean
language sql stable set search_path = public, app as $fn$
  select p_date is not null and exists (
    select 1 from public.daily_closings where business_date = p_date and status = 'closed' and branch_id = p_branch)
$fn$;
create or replace function app.is_day_closed(p_date date) returns boolean
language sql stable set search_path = public, app as $fn$
  select app.is_day_closed(p_date, coalesce(app.request_branch_id(), app.default_branch_id()))
$fn$;

-- The closed-day lock applies to the row's own branch.
create or replace function app.guard_closed_day() returns trigger
language plpgsql set search_path = public, app as $fn$
declare v_day date; v_b uuid := coalesce(new.branch_id, old.branch_id);
begin
  case tg_table_name
  when 'expenses' then
    if tg_op = 'INSERT' and app.is_day_closed(new.expense_date, v_b) then v_day := new.expense_date;
    elsif tg_op = 'DELETE' and app.is_day_closed(old.expense_date, v_b) then v_day := old.expense_date;
    elsif tg_op = 'UPDATE'
      and (new.category, new.description, new.amount_cents, new.expense_date, new.supplier_id, new.vendor)
          is distinct from (old.category, old.description, old.amount_cents, old.expense_date, old.supplier_id, old.vendor) then
      if app.is_day_closed(old.expense_date, v_b) then v_day := old.expense_date;
      elsif app.is_day_closed(new.expense_date, v_b) then v_day := new.expense_date; end if;
    end if;
  when 'cash_counts' then
    if app.is_day_closed(new.business_date, v_b) then v_day := new.business_date; end if;
  when 'cash_movements' then
    if app.is_day_closed(new.business_date, v_b) then v_day := new.business_date; end if;
  when 'payments' then
    if tg_op = 'INSERT' then
      if app.is_day_closed(app.business_day(new.created_at), v_b) then v_day := app.business_day(new.created_at); end if;
    elsif tg_op = 'DELETE' then
      if app.is_day_closed(app.business_day(old.created_at), v_b) then v_day := app.business_day(old.created_at); end if;
    elsif (new.amount_cents is distinct from old.amount_cents
           or (new.status = 'voided' and old.status is distinct from 'voided'))
          and app.is_day_closed(app.business_day(old.created_at), v_b) then
      v_day := app.business_day(old.created_at);
    end if;
  when 'orders' then
    if tg_op = 'DELETE' then
      if old.status in ('served', 'paid') and app.is_day_closed(app.business_day(coalesce(old.paid_at, old.created_at)), v_b) then
        v_day := app.business_day(coalesce(old.paid_at, old.created_at));
      end if;
    elsif old.status in ('served', 'paid')
          and (new.status = 'void' or new.subtotal_cents is distinct from old.subtotal_cents
               or new.discount_cents is distinct from old.discount_cents or new.total_cents is distinct from old.total_cents)
          and app.is_day_closed(app.business_day(coalesce(old.paid_at, old.created_at)), v_b) then
      v_day := app.business_day(coalesce(old.paid_at, old.created_at));
    end if;
  end case;
  if v_day is not null then
    raise exception 'day_closed: % is closed for this branch', v_day using errcode = 'insufficient_privilege',
      hint = 'Reopen the day with a reason, or record the correction on an open day (a refund is always allowed).';
  end if;
  return coalesce(new, old);
end $fn$;

-- The closed-day guard on expenses now runs after the branch is filled in.
create or replace function public.day_close_preview(p_business_date date, p_opening_cents integer default 0) returns jsonb
language plpgsql stable security definer set search_path = public, app as $fn$
declare
  v_b uuid := coalesce(app.request_branch_id(), app.default_branch_id());
  v_s jsonb; v_mov int; v_tax bigint; v_mix jsonb; v_exp jsonb; v_supp jsonb; v_count jsonb;
  v_open_orders int; v_unpaid jsonb; v_awaiting int; v_holds int; v_closing public.daily_closings; v_branch public.branches;
begin
  if not (app.has_perm('finance.close_day') or app.has_perm('finance.view') or app.has_perm('finance.reconcile') or app.has_perm('cash.manage')) then
    raise exception 'forbidden' using errcode = 'insufficient_privilege';
  end if;
  if not app.branch_access(v_b) then raise exception 'forbidden' using errcode = 'insufficient_privilege'; end if;
  select * into v_branch from public.branches where id = v_b;
  v_s := app.day_sales(p_business_date, v_b);
  v_mov := app.day_cash_movements(p_business_date, v_b);

  select coalesce(sum(tax_cents), 0) into v_tax from public.orders
   where branch_id = v_b and status in ('served', 'paid') and app.business_day(coalesce(paid_at, created_at)) = p_business_date;

  with o as (
    select id from public.orders
     where branch_id = v_b and status in ('served', 'paid') and app.business_day(coalesce(paid_at, created_at)) = p_business_date
  )
  select coalesce(jsonb_object_agg(method, cents), '{}'::jsonb) into v_mix
    from (select p.method, sum(p.amount_cents - p.refunded_cents)::bigint as cents
            from public.payments p join o on o.id = p.order_id
           where p.status <> 'voided' group by p.method) x;

  select jsonb_build_object('count', count(*), 'cents', coalesce(sum(amount_cents), 0)) into v_exp
    from public.expenses where branch_id = v_b and expense_date = p_business_date and status in ('approved', 'paid');
  -- Supplier payments are made by the organization, not a till: shown for information.
  select jsonb_build_object('count', count(*), 'cents', coalesce(sum(amount_cents), 0)) into v_supp
    from public.supplier_payments where app.business_day(paid_at) = p_business_date;
  select to_jsonb(c) - 'counted_by' into v_count from public.cash_counts c
   where c.branch_id = v_b and c.business_date = p_business_date order by c.created_at desc limit 1;

  select count(*) into v_open_orders from public.orders
   where branch_id = v_b and status in ('pending', 'in_kitchen', 'ready') and app.business_day(created_at) = p_business_date;
  select jsonb_build_object('count', count(*), 'cents', coalesce(sum(due), 0)) into v_unpaid
    from (select o.total_cents - coalesce((select sum(p.amount_cents - p.refunded_cents) from public.payments p
                                            where p.order_id = o.id and p.status <> 'voided'), 0) as due
            from public.orders o
           where o.branch_id = v_b and o.status = 'served' and app.business_day(coalesce(o.paid_at, o.created_at)) = p_business_date) u
   where due > 0;
  select count(*) into v_awaiting from public.expenses where branch_id = v_b and expense_date = p_business_date and status in ('draft', 'submitted');
  select count(*) into v_holds from public.supplier_payment_holds where status = 'open';
  select * into v_closing from public.daily_closings where branch_id = v_b and business_date = p_business_date;

  return jsonb_build_object(
    'business_date', p_business_date,
    'branch', jsonb_build_object('id', v_branch.id, 'code', v_branch.code, 'name', v_branch.name),
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

create or replace function public.close_business_day(
  p_business_date date, p_opening_cash integer default 0, p_closing_cash integer default null, p_note text default null
) returns public.daily_closings
language plpgsql security definer set search_path = public, app as $fn$
declare v_b uuid := coalesce(app.request_branch_id(), app.default_branch_id());
  v_p jsonb; v_s jsonb; v_mov int; v_expected int; v_diff int; v_row public.daily_closings;
begin
  if not app.has_perm('finance.close_day') or not app.branch_access(v_b) then
    raise exception 'forbidden' using errcode = 'insufficient_privilege';
  end if;
  if p_business_date > app.business_day(now()) then
    raise exception 'future_day: % has not happened yet', p_business_date using errcode = 'check_violation';
  end if;
  if app.is_day_closed(p_business_date, v_b) then
    raise exception 'already_closed: reopen % first', p_business_date using errcode = 'check_violation';
  end if;
  if coalesce(p_opening_cash, 0) < 0 or coalesce(p_closing_cash, 0) < 0 then
    raise exception 'bad_amount' using errcode = 'check_violation';
  end if;

  v_p := public.day_close_preview(p_business_date, coalesce(p_opening_cash, 0));
  v_s := app.day_sales(p_business_date, v_b);
  v_mov := app.day_cash_movements(p_business_date, v_b);
  v_expected := coalesce(p_opening_cash, 0) + (v_s->>'cash_in_cents')::int + v_mov;
  v_diff := case when p_closing_cash is null then null else p_closing_cash - v_expected end;
  if v_diff is not null and v_diff <> 0 and coalesce(trim(p_note), '') = '' then
    raise exception 'variance_reason_required: counted cash differs from expected by %', v_diff using errcode = 'check_violation';
  end if;

  insert into public.daily_closings (
    branch_id, business_date, status, opening_cash_cents, closing_cash_cents, expected_cash_cents,
    difference_cents, gross_sales_cents, discounts_cents, refunds_cents, net_sales_cents,
    order_count, cash_movements_cents, summary, note, closed_by, closed_at
  ) values (
    v_b, p_business_date, 'closed', coalesce(p_opening_cash, 0), p_closing_cash, v_expected, v_diff,
    (v_s->>'gross_sales_cents')::int, (v_s->>'discounts_cents')::int, (v_s->>'refunds_cents')::int,
    (v_s->>'net_sales_cents')::int, (v_s->>'order_count')::int, v_mov, v_p,
    nullif(trim(p_note), ''), app.jwt_sub(), now()
  )
  on conflict (branch_id, business_date) do update set
    status = 'closed', opening_cash_cents = excluded.opening_cash_cents,
    closing_cash_cents = excluded.closing_cash_cents, expected_cash_cents = excluded.expected_cash_cents,
    difference_cents = excluded.difference_cents, gross_sales_cents = excluded.gross_sales_cents,
    discounts_cents = excluded.discounts_cents, refunds_cents = excluded.refunds_cents,
    net_sales_cents = excluded.net_sales_cents, order_count = excluded.order_count,
    cash_movements_cents = excluded.cash_movements_cents, summary = excluded.summary,
    note = coalesce(excluded.note, public.daily_closings.note),
    closed_by = excluded.closed_by, closed_at = now()
  returning * into v_row;

  perform app.log_action('day.closed', 'daily_closings', p_business_date::text, null, to_jsonb(v_row) - 'summary');
  return v_row;
end $fn$;

create or replace function public.reopen_business_day(p_business_date date, p_reason text) returns void
language plpgsql security definer set search_path = public, app as $fn$
declare v_b uuid := coalesce(app.request_branch_id(), app.default_branch_id());
begin
  if not app.has_perm('finance.reopen_day') or not app.branch_access(v_b) then
    raise exception 'forbidden' using errcode = 'insufficient_privilege';
  end if;
  if coalesce(trim(p_reason), '') = '' then raise exception 'reason_required' using errcode = 'check_violation'; end if;
  update public.daily_closings
     set status = 'open', reopened_by = app.jwt_sub(), reopened_at = now(), note = trim(p_reason)
   where branch_id = v_b and business_date = p_business_date and status = 'closed';
  if not found then raise exception 'not_closed' using errcode = 'no_data_found'; end if;
  perform app.log_action('day.reopened', 'daily_closings', p_business_date::text, null,
                         jsonb_build_object('reason', trim(p_reason), 'branch_id', v_b));
end $fn$;

create or replace function public.record_cash_count(p_business_date date, p_opening_cents integer, p_counted_cents integer, p_note text default null)
returns public.cash_counts
language plpgsql security definer set search_path = public, app as $fn$
declare v_b uuid := coalesce(app.request_branch_id(), app.default_branch_id()); v_expected int; v_row public.cash_counts;
begin
  if not app.has_perm('finance.reconcile') or not app.branch_access(v_b) then
    raise exception 'forbidden' using errcode = 'insufficient_privilege';
  end if;
  if coalesce(p_counted_cents, -1) < 0 or coalesce(p_opening_cents, 0) < 0 then
    raise exception 'bad_amount' using errcode = 'check_violation';
  end if;
  v_expected := coalesce(p_opening_cents, 0)
              + coalesce((app.day_sales(p_business_date, v_b)->>'cash_in_cents')::int, 0)
              + app.day_cash_movements(p_business_date, v_b);
  insert into public.cash_counts
    (branch_id, business_date, opening_cents, counted_cents, expected_cents, difference_cents, note, counted_by, counted_by_email)
  values
    (v_b, p_business_date, coalesce(p_opening_cents, 0), p_counted_cents, v_expected, p_counted_cents - v_expected,
     nullif(trim(p_note), ''), app.jwt_sub(), nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'email')
  returning * into v_row;
  perform app.log_action('cash.counted', 'cash_counts', v_row.id::text, null,
                         jsonb_build_object('counted', p_counted_cents, 'expected', v_expected, 'branch_id', v_b));
  return v_row;
end $fn$;

create or replace function public.record_cash_movement(
  p_business_date date, p_kind text, p_amount_cents integer, p_reason text, p_reference text default null
) returns public.cash_movements
language plpgsql security definer set search_path = public, app as $fn$
declare v_b uuid := coalesce(app.request_branch_id(), app.default_branch_id()); v_row public.cash_movements;
begin
  if not (app.has_perm('cash.manage') or app.has_perm('finance.reconcile')) or not app.branch_access(v_b) then
    raise exception 'forbidden' using errcode = 'insufficient_privilege';
  end if;
  if coalesce(trim(p_reason), '') = '' then raise exception 'reason_required' using errcode = 'check_violation'; end if;
  if p_business_date > app.business_day(now()) then raise exception 'future_day' using errcode = 'check_violation'; end if;
  insert into public.cash_movements (branch_id, business_date, kind, amount_cents, reason, reference, created_by)
  values (v_b, coalesce(p_business_date, app.business_day(now())), p_kind, p_amount_cents, trim(p_reason), nullif(trim(p_reference), ''), app.jwt_sub())
  returning * into v_row;
  perform app.log_action('cash.movement', 'cash_movements', v_row.id::text, null,
    jsonb_build_object('kind', p_kind, 'amount_cents', v_row.signed_cents, 'reason', trim(p_reason), 'business_date', v_row.business_date, 'branch_id', v_b));
  return v_row;
end $fn$;
