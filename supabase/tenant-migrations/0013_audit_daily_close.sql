-- ============================================================================
-- Tenant delta 0013 — P8: audit attribution + order lifecycle audit + day close
--
--   * audit_logs.portal_id; app.audit_row() + app.log_action() stamp the
--     portal a change was made from (app.current_portal_id()).
--   * app.audit_order() — a targeted trigger logging order create + meaningful
--     status/payment/total changes (not the KDS line churn).
--   * daily_closings + close_business_day / reopen_business_day
--     (finance.close_day / finance.reopen_day, audited).
--
-- Depends on 0009 (payments), 0011 (app.business_day). Idempotent.
-- ============================================================================

alter table public.audit_logs add column if not exists portal_id uuid;

create or replace function app.audit_row() returns trigger
language plpgsql security definer set search_path = public, app as $$
declare v_claims jsonb := nullif(current_setting('request.jwt.claims', true), '')::jsonb;
begin
  insert into public.audit_logs (
    actor_id, actor_email, actor_role, portal_id, action, entity, entity_id, before, after
  ) values (
    (v_claims #>> '{sub}')::uuid, v_claims #>> '{email}', app.current_member_role(),
    app.current_portal_id(),
    tg_op, tg_table_name, coalesce(to_jsonb(new) ->> 'id', to_jsonb(old) ->> 'id'),
    case when tg_op in ('UPDATE', 'DELETE') then to_jsonb(old) end,
    case when tg_op in ('UPDATE', 'INSERT') then to_jsonb(new) end
  );
  return coalesce(new, old);
end $$;

create or replace function app.log_action(
  p_action text, p_entity text, p_entity_id text,
  p_before jsonb default null, p_after jsonb default null
) returns void language plpgsql security definer set search_path = public, app as $$
declare v_claims jsonb := nullif(current_setting('request.jwt.claims', true), '')::jsonb;
begin
  insert into public.audit_logs
    (actor_id, actor_email, actor_role, portal_id, action, entity, entity_id, before, after)
  values
    (app.jwt_sub(), v_claims #>> '{email}', app.current_member_role(), app.current_portal_id(),
     p_action, p_entity, p_entity_id, p_before, p_after);
end $$;

-- ── Order lifecycle audit (create + meaningful updates only) ─────────────
create or replace function app.audit_order() returns trigger
language plpgsql security definer set search_path = public, app as $$
begin
  if tg_op = 'INSERT' then
    perform app.log_action('order.created', 'orders', new.id::text, null,
      jsonb_build_object('order_number', new.order_number, 'status', new.status));
  elsif tg_op = 'UPDATE' and (
      new.status is distinct from old.status
      or new.payment_method is distinct from old.payment_method
      or (new.paid_at is null) is distinct from (old.paid_at is null)
      or new.total_cents is distinct from old.total_cents
      or coalesce(new.refunded_cents, 0) is distinct from coalesce(old.refunded_cents, 0)
  ) then
    perform app.log_action('order.updated', 'orders', new.id::text,
      jsonb_build_object('status', old.status, 'total_cents', old.total_cents,
                         'payment_method', old.payment_method, 'refunded_cents', old.refunded_cents),
      jsonb_build_object('status', new.status, 'total_cents', new.total_cents,
                         'payment_method', new.payment_method, 'refunded_cents', new.refunded_cents));
  end if;
  return coalesce(new, old);
end $$;
drop trigger if exists audit_order on public.orders;
create trigger audit_order after insert or update on public.orders
  for each row execute function app.audit_order();

-- ── Daily closing ──────────────────────────────────────────────────────
create table if not exists public.daily_closings (
  id                 uuid primary key default gen_random_uuid(),
  business_date      date not null unique,
  status             text not null default 'open' check (status in ('open','closed')),
  opening_cash_cents int not null default 0,
  closing_cash_cents int,
  expected_cash_cents int,
  difference_cents   int,
  gross_sales_cents  int not null default 0,
  discounts_cents    int not null default 0,
  refunds_cents      int not null default 0,
  net_sales_cents    int not null default 0,
  order_count        int not null default 0,
  note               text,
  closed_by          uuid,
  closed_at          timestamptz,
  reopened_by        uuid,
  reopened_at        timestamptz,
  created_at         timestamptz not null default now()
);
alter table public.daily_closings enable row level security;
drop policy if exists staff_read on public.daily_closings;
create policy staff_read on public.daily_closings for select using (app.has_perm('finance.view') or app.is_staff());

create or replace function app.day_sales(p_date date)
returns jsonb language sql stable set search_path = public, app as $$
  with o as (
    select * from public.orders
    where status in ('served','paid') and app.business_day(coalesce(paid_at, created_at)) = p_date
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
$$;

create or replace function public.close_business_day(
  p_business_date date, p_opening_cash int default 0,
  p_closing_cash int default null, p_note text default null
) returns public.daily_closings
language plpgsql security definer set search_path = public, app as $$
declare v_s jsonb; v_expected int; v_diff int; v_row public.daily_closings;
begin
  if not app.has_perm('finance.close_day') then
    raise exception 'forbidden' using errcode = 'insufficient_privilege';
  end if;
  v_s := app.day_sales(p_business_date);
  v_expected := coalesce(p_opening_cash, 0) + (v_s->>'cash_in_cents')::int;
  v_diff := case when p_closing_cash is null then null else p_closing_cash - v_expected end;

  insert into public.daily_closings (
    business_date, status, opening_cash_cents, closing_cash_cents, expected_cash_cents,
    difference_cents, gross_sales_cents, discounts_cents, refunds_cents, net_sales_cents,
    order_count, note, closed_by, closed_at
  ) values (
    p_business_date, 'closed', coalesce(p_opening_cash, 0), p_closing_cash, v_expected, v_diff,
    (v_s->>'gross_sales_cents')::int, (v_s->>'discounts_cents')::int, (v_s->>'refunds_cents')::int,
    (v_s->>'net_sales_cents')::int, (v_s->>'order_count')::int, p_note, app.jwt_sub(), now()
  )
  on conflict (business_date) do update set
    status = 'closed', opening_cash_cents = excluded.opening_cash_cents,
    closing_cash_cents = excluded.closing_cash_cents, expected_cash_cents = excluded.expected_cash_cents,
    difference_cents = excluded.difference_cents, gross_sales_cents = excluded.gross_sales_cents,
    discounts_cents = excluded.discounts_cents, refunds_cents = excluded.refunds_cents,
    net_sales_cents = excluded.net_sales_cents, order_count = excluded.order_count,
    note = coalesce(excluded.note, public.daily_closings.note),
    closed_by = excluded.closed_by, closed_at = now()
  returning * into v_row;

  perform app.log_action('day.closed', 'daily_closings', p_business_date::text, null, to_jsonb(v_row));
  return v_row;
end $$;
revoke all on function public.close_business_day(date, int, int, text) from public;
grant execute on function public.close_business_day(date, int, int, text) to authenticated, service_role;

create or replace function public.reopen_business_day(p_business_date date, p_reason text)
returns void language plpgsql security definer set search_path = public, app as $$
begin
  if not app.has_perm('finance.reopen_day') then
    raise exception 'forbidden' using errcode = 'insufficient_privilege';
  end if;
  update public.daily_closings
     set status = 'open', reopened_by = app.jwt_sub(), reopened_at = now(),
         note = coalesce(nullif(trim(p_reason), ''), note)
   where business_date = p_business_date;
  if not found then raise exception 'not_found' using errcode = 'no_data_found'; end if;
  perform app.log_action('day.reopened', 'daily_closings', p_business_date::text, null,
                         jsonb_build_object('reason', p_reason));
end $$;
revoke all on function public.reopen_business_day(date, text) from public;
grant execute on function public.reopen_business_day(date, text) to authenticated, service_role;

do $$ begin
  execute 'create trigger audit after insert or update or delete on public.daily_closings for each row execute function app.audit_row()';
exception when duplicate_object then null; end $$;
