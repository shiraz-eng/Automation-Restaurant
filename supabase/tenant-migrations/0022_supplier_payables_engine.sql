-- 0022: Supplier management, purchasing lifecycle, and accounts-payable
-- engine (spec: SUPPLIER MANAGEMENT + PURCHASING + PAYABLES + AI AUTOMATION).
--
-- Reuses rather than duplicates: suppliers, purchase_orders,
-- purchase_order_lines, receive_purchase_order(_line), stock_ledger's
-- weighted-average costing, and the finance/inventory permission domains
-- all already existed (0002, 0020, 0021) — this extends them with the
-- pieces that made this only a contact directory: a supplier price catalog,
-- PO approval, accept/reject receiving, supplier invoices, three-way
-- matching with configurable tolerance, payment holds, credit notes,
-- payments with multi-invoice allocation, and ONE authoritative accounts-
-- payable ledger (public.supplier_payable / public.supplier_statement).

-- ── permission catalog ─────────────────────────────────────────────────────
insert into public.permission_catalog (key, grp, label) values
  ('purchases.approve','Purchases','Approve purchase orders'),
  ('invoices.view','Invoices','View supplier invoices'),
  ('invoices.create','Invoices','Create/upload supplier invoices'),
  ('invoices.match','Invoices','Run/approve invoice matching'),
  ('payables.view','Payables','View accounts payable'),
  ('payables.record_payment','Payables','Record supplier payments'),
  ('payables.manage','Payables','Resolve payment holds, credit notes')
on conflict (key) do update set grp = excluded.grp, label = excluded.label;

update public.roles
   set permissions = (
     select array(select distinct unnest(
       permissions || array['purchases.approve','invoices.view','invoices.create','invoices.match','payables.view']
     ))
   )
 where key = 'manager';

update public.roles
   set permissions = (
     select array(select distinct unnest(
       permissions || array[
         'purchases.approve','invoices.view','invoices.create','invoices.match',
         'payables.view','payables.record_payment','payables.manage'
       ]
     ))
   )
 where key = 'accountant';

-- ── suppliers: commercial fields ────────────────────────────────────────
alter table public.suppliers
  add column if not exists currency text not null default 'USD',
  add column if not exists credit_period_days int not null default 30,
  add column if not exists preferred_payment_method text,
  add column if not exists is_active boolean not null default true;

-- ── purchase_orders: approval gate + subtotal ───────────────────────────
-- A plain timestamp gate rather than new po_status enum values — safer
-- than ALTER TYPE ADD VALUE mid-migration (a new enum value can't be used
-- in the same transaction it was added in).
alter table public.purchase_orders
  add column if not exists requested_by uuid,
  add column if not exists approved_by uuid,
  add column if not exists approved_at timestamptz,
  add column if not exists sent_at timestamptz,
  add column if not exists payment_terms_days int,
  add column if not exists subtotal_cents int not null default 0;

-- ── purchase_order_lines: accept/reject split on receiving ─────────────
alter table public.purchase_order_lines
  add column if not exists rejected_qty numeric(14,3) not null default 0,
  add column if not exists reject_reason text;

create or replace function app.recalc_po_subtotal() returns trigger
language plpgsql set search_path = public, app as $fn$
declare v_po uuid;
begin
  v_po := coalesce(new.purchase_order_id, old.purchase_order_id);
  update public.purchase_orders
     set subtotal_cents = coalesce(
       (select sum(pol.qty * pol.unit_cost_cents) from public.purchase_order_lines pol where pol.purchase_order_id = v_po), 0)
   where id = v_po;
  return null;
end $fn$;
drop trigger if exists recalc_po_subtotal on public.purchase_order_lines;
create trigger recalc_po_subtotal after insert or update or delete on public.purchase_order_lines
  for each row execute function app.recalc_po_subtotal();

create or replace function public.approve_purchase_order(p_po_id uuid) returns void
language plpgsql security definer set search_path = public, app as $fn$
begin
  if not (app.has_perm('purchases.approve') or app.can_write()) then
    raise exception 'forbidden' using errcode = 'insufficient_privilege';
  end if;
  update public.purchase_orders set approved_by = app.jwt_sub(), approved_at = now()
   where id = p_po_id and status = 'draft';
  if not found then raise exception 'not_approvable' using errcode = 'check_violation'; end if;
end $fn$;
revoke all on function public.approve_purchase_order(uuid) from public;
grant execute on function public.approve_purchase_order(uuid) to authenticated, service_role;

create or replace function public.send_purchase_order(p_po_id uuid) returns void
language plpgsql security definer set search_path = public, app as $fn$
declare v_approved timestamptz;
begin
  if not (app.has_perm('purchases.update') or app.can_write()) then
    raise exception 'forbidden' using errcode = 'insufficient_privilege';
  end if;
  select approved_at into v_approved from public.purchase_orders where id = p_po_id;
  if not found then raise exception 'po_not_found' using errcode = 'no_data_found'; end if;
  if v_approved is null then raise exception 'not_approved' using errcode = 'check_violation'; end if;
  update public.purchase_orders set status = 'sent', sent_at = now() where id = p_po_id and status = 'draft';
end $fn$;
revoke all on function public.send_purchase_order(uuid) from public;
grant execute on function public.send_purchase_order(uuid) to authenticated, service_role;

-- receive_purchase_order_line: rewritten with an accept/reject split — the
-- previous 2-arg version isn't called from any screen yet, so it's dropped
-- outright rather than kept alongside.
drop function if exists public.receive_purchase_order_line(uuid, numeric);
create or replace function public.receive_purchase_order_line(
  p_line_id uuid, p_qty numeric, p_rejected_qty numeric default 0, p_reject_reason text default null
) returns void
language plpgsql security definer set search_path = public, app as $fn$
declare
  r record; v_factor numeric; v_old_stock numeric; v_old_cost numeric;
  v_take numeric; v_accept numeric; v_recv_base numeric; v_receipt_cost_per_base numeric; v_new_cost numeric;
  v_remaining_lines int;
begin
  if not (app.has_perm('purchases.receive') or app.has_perm('inventory.manage_purchases') or app.can_write()) then
    raise exception 'forbidden' using errcode = 'insufficient_privilege';
  end if;
  if coalesce(p_qty, 0) <= 0 then raise exception 'bad_qty' using errcode = 'check_violation'; end if;
  if coalesce(p_rejected_qty, 0) < 0 or coalesce(p_rejected_qty, 0) > p_qty then
    raise exception 'bad_rejected_qty' using errcode = 'check_violation';
  end if;
  select id, purchase_order_id, inventory_item_id, qty, received_qty, unit_cost_cents
    into r from public.purchase_order_lines where id = p_line_id;
  if not found then raise exception 'line_not_found' using errcode = 'foreign_key_violation'; end if;
  v_take := least(p_qty, r.qty - r.received_qty);
  if v_take <= 0 then raise exception 'nothing_outstanding' using errcode = 'check_violation'; end if;
  v_accept := v_take - least(coalesce(p_rejected_qty, 0), v_take);

  if r.inventory_item_id is not null and v_accept > 0 then
    select purchase_unit_to_base, stock_qty, cost_cents_per_base_unit
      into v_factor, v_old_stock, v_old_cost
      from public.inventory_items where id = r.inventory_item_id;
    v_recv_base := v_accept * coalesce(v_factor, 1);
    v_receipt_cost_per_base := r.unit_cost_cents / greatest(coalesce(v_factor, 1), 0.0001);
    v_new_cost := case when (coalesce(v_old_stock, 0) + v_recv_base) > 0
      then (coalesce(v_old_stock, 0) * coalesce(v_old_cost, 0) + v_recv_base * v_receipt_cost_per_base)
           / (coalesce(v_old_stock, 0) + v_recv_base)
      else coalesce(v_old_cost, 0) end;
    update public.inventory_items
       set stock_qty = stock_qty + v_recv_base, cost_cents_per_base_unit = v_new_cost
     where id = r.inventory_item_id;
    insert into public.stock_ledger (inventory_item_id, delta_qty, reason, note, unit_cost_cents_base)
    values (r.inventory_item_id, v_recv_base, 'restock', 'PO partial receipt', v_receipt_cost_per_base);
  end if;
  update public.purchase_order_lines
     set received_qty = received_qty + v_take,
         rejected_qty = rejected_qty + coalesce(p_rejected_qty, 0),
         reject_reason = coalesce(p_reject_reason, reject_reason)
   where id = p_line_id;

  select count(*) into v_remaining_lines from public.purchase_order_lines
   where purchase_order_id = r.purchase_order_id and received_qty < qty;
  update public.purchase_orders
     set status = case when v_remaining_lines = 0 then 'received'::app.po_status else 'partial'::app.po_status end,
         received_at = case when v_remaining_lines = 0 then now() else received_at end
   where id = r.purchase_order_id;
end $fn$;
revoke all on function public.receive_purchase_order_line(uuid, numeric, numeric, text) from public;
grant execute on function public.receive_purchase_order_line(uuid, numeric, numeric, text) to authenticated, service_role;

-- ── Supplier price catalog ───────────────────────────────────────────────
create table if not exists public.supplier_items (
  id                     uuid primary key default gen_random_uuid(),
  supplier_id            uuid not null references public.suppliers(id) on delete cascade,
  inventory_item_id      uuid not null references public.inventory_items(id) on delete cascade,
  supplier_sku           text,
  supplier_item_name     text,
  purchase_unit_label    text,
  purchase_unit_to_base  numeric(14,4) not null default 1 check (purchase_unit_to_base > 0),
  current_price_cents    int not null default 0 check (current_price_cents >= 0),
  moq                    numeric(14,3),
  lead_time_days         int,
  is_preferred           boolean not null default false,
  is_active              boolean not null default true,
  updated_at             timestamptz not null default now(),
  unique (supplier_id, inventory_item_id)
);
create index if not exists supplier_items_item_idx on public.supplier_items(inventory_item_id);

create table if not exists public.supplier_price_history (
  id                 uuid primary key default gen_random_uuid(),
  supplier_item_id   uuid not null references public.supplier_items(id) on delete cascade,
  old_price_cents    int,
  new_price_cents    int not null,
  pct_change         numeric(7,2),
  effective_date     date not null default current_date,
  source             text not null default 'manual' check (source in ('manual','purchase_order','invoice')),
  reference_id       uuid,
  created_at         timestamptz not null default now()
);
create index if not exists supplier_price_history_item_idx on public.supplier_price_history(supplier_item_id, effective_date desc);

alter table public.supplier_items enable row level security;
alter table public.supplier_price_history enable row level security;
drop policy if exists staff_read on public.supplier_items;
drop policy if exists mgr_write on public.supplier_items;
create policy staff_read on public.supplier_items for select using (app.has_perm('supplier.view') or app.is_staff());
create policy mgr_write on public.supplier_items for all using (app.has_perm('supplier.manage') or app.can_write()) with check (app.has_perm('supplier.manage') or app.can_write());
drop policy if exists staff_read on public.supplier_price_history;
create policy staff_read on public.supplier_price_history for select using (app.has_perm('supplier.view') or app.is_staff());

create or replace function public.set_supplier_item_price(
  p_supplier_item_id uuid, p_new_price_cents int, p_source text default 'manual', p_reference_id uuid default null
) returns void
language plpgsql security definer set search_path = public, app as $fn$
declare v_old int;
begin
  if not (app.has_perm('supplier.manage') or app.can_write()) then
    raise exception 'forbidden' using errcode = 'insufficient_privilege';
  end if;
  if coalesce(p_new_price_cents, 0) < 0 then raise exception 'bad_price' using errcode = 'check_violation'; end if;
  select current_price_cents into v_old from public.supplier_items where id = p_supplier_item_id;
  if not found then raise exception 'supplier_item_not_found' using errcode = 'foreign_key_violation'; end if;
  update public.supplier_items set current_price_cents = p_new_price_cents, updated_at = now()
   where id = p_supplier_item_id;
  insert into public.supplier_price_history
    (supplier_item_id, old_price_cents, new_price_cents, pct_change, source, reference_id)
  values (p_supplier_item_id, v_old, p_new_price_cents,
    case when coalesce(v_old,0) > 0 then round((p_new_price_cents - v_old)::numeric / v_old * 1000) / 10 else null end,
    coalesce(nullif(p_source,''),'manual'), p_reference_id);
end $fn$;
revoke all on function public.set_supplier_item_price(uuid, int, text, uuid) from public;
grant execute on function public.set_supplier_item_price(uuid, int, text, uuid) to authenticated, service_role;

-- ── Purchasing settings — matching tolerances ───────────────────────────
create table if not exists public.purchasing_settings (
  id                     boolean primary key default true check (id),
  qty_tolerance_pct      numeric(5,2) not null default 2,
  price_tolerance_pct    numeric(5,2) not null default 1
);
insert into public.purchasing_settings (id) values (true) on conflict (id) do nothing;
alter table public.purchasing_settings enable row level security;
drop policy if exists staff_read on public.purchasing_settings;
drop policy if exists mgr_write on public.purchasing_settings;
create policy staff_read on public.purchasing_settings for select using (app.has_perm('finance.view') or app.is_staff());
create policy mgr_write on public.purchasing_settings for all using (app.has_perm('finance.manage_purchases') or app.can_write()) with check (app.has_perm('finance.manage_purchases') or app.can_write());

-- ── Supplier invoices ────────────────────────────────────────────────────
do $$ begin
  create type app.invoice_status as enum (
    'received','matched','on_hold','approved','partially_paid','paid','cancelled'
  );
exception when duplicate_object then null; end $$;

create table if not exists public.invoice_counter (
  id boolean primary key default true check (id),
  next_number bigint not null default 1
);
insert into public.invoice_counter default values on conflict (id) do nothing;
create or replace function public.next_invoice_ref() returns bigint
language plpgsql security definer set search_path = public, app as $fn$
declare v bigint;
begin
  update public.invoice_counter set next_number = next_number + 1 where id returning next_number - 1 into v;
  return v;
end $fn$;
grant execute on function public.next_invoice_ref() to authenticated, service_role;

create table if not exists public.supplier_invoices (
  id                     uuid primary key default gen_random_uuid(),
  invoice_ref            bigint not null unique default public.next_invoice_ref(),
  supplier_id            uuid not null references public.suppliers(id) on delete restrict,
  purchase_order_id      uuid references public.purchase_orders(id) on delete set null,
  supplier_invoice_number text not null,
  invoice_date           date not null,
  due_date               date,
  currency               text not null default 'USD',
  subtotal_cents         int not null default 0 check (subtotal_cents >= 0),
  tax_cents              int not null default 0 check (tax_cents >= 0),
  discount_cents         int not null default 0 check (discount_cents >= 0),
  delivery_fee_cents     int not null default 0 check (delivery_fee_cents >= 0),
  total_cents            int not null default 0 check (total_cents >= 0),
  status                 app.invoice_status not null default 'received',
  attachment_path        text,
  notes                  text,
  created_by             uuid,
  created_at             timestamptz not null default now(),
  unique (supplier_id, supplier_invoice_number)
);
create index if not exists supplier_invoices_supplier_idx on public.supplier_invoices(supplier_id, invoice_date desc);
create index if not exists supplier_invoices_status_idx on public.supplier_invoices(status);

create or replace function app.default_invoice_due_date() returns trigger
language plpgsql set search_path = public, app as $fn$
declare v_days int;
begin
  if new.due_date is null then
    select credit_period_days into v_days from public.suppliers where id = new.supplier_id;
    new.due_date := new.invoice_date + make_interval(days => coalesce(v_days, 30));
  end if;
  return new;
end $fn$;
drop trigger if exists default_invoice_due_date on public.supplier_invoices;
create trigger default_invoice_due_date before insert on public.supplier_invoices
  for each row execute function app.default_invoice_due_date();

create table if not exists public.supplier_invoice_lines (
  id                uuid primary key default gen_random_uuid(),
  invoice_id        uuid not null references public.supplier_invoices(id) on delete cascade,
  po_line_id        uuid references public.purchase_order_lines(id) on delete set null,
  inventory_item_id uuid references public.inventory_items(id) on delete set null,
  description       text not null,
  qty               numeric(14,3) not null check (qty > 0),
  unit_cost_cents   int not null default 0 check (unit_cost_cents >= 0),
  line_total_cents  int not null default 0 check (line_total_cents >= 0)
);
create index if not exists supplier_invoice_lines_invoice_idx on public.supplier_invoice_lines(invoice_id);

alter table public.supplier_invoices enable row level security;
alter table public.supplier_invoice_lines enable row level security;
drop policy if exists staff_read on public.supplier_invoices;
drop policy if exists mgr_write on public.supplier_invoices;
create policy staff_read on public.supplier_invoices for select using (app.has_perm('invoices.view') or app.has_perm('purchases.view') or app.is_staff());
create policy mgr_write on public.supplier_invoices for all using (app.has_perm('invoices.create') or app.can_write()) with check (app.has_perm('invoices.create') or app.can_write());
drop policy if exists staff_read on public.supplier_invoice_lines;
drop policy if exists mgr_write on public.supplier_invoice_lines;
create policy staff_read on public.supplier_invoice_lines for select using (app.has_perm('invoices.view') or app.has_perm('purchases.view') or app.is_staff());
create policy mgr_write on public.supplier_invoice_lines for all using (app.has_perm('invoices.create') or app.can_write()) with check (app.has_perm('invoices.create') or app.can_write());

insert into storage.buckets (id, name, public)
values ('supplier-invoices', 'supplier-invoices', false)
on conflict (id) do nothing;
drop policy if exists "supplier-invoices staff read" on storage.objects;
drop policy if exists "supplier-invoices staff write" on storage.objects;
create policy "supplier-invoices staff read" on storage.objects for select
  using (bucket_id = 'supplier-invoices' and (app.has_perm('invoices.view') or app.is_staff()));
create policy "supplier-invoices staff write" on storage.objects for all
  using (bucket_id = 'supplier-invoices' and (app.has_perm('invoices.create') or app.can_write()))
  with check (bucket_id = 'supplier-invoices' and (app.has_perm('invoices.create') or app.can_write()));

-- ── Payment holds ────────────────────────────────────────────────────────
create table if not exists public.supplier_payment_holds (
  id               uuid primary key default gen_random_uuid(),
  invoice_id       uuid not null references public.supplier_invoices(id) on delete cascade,
  reason           text not null,
  amount_cents     int not null check (amount_cents >= 0),
  status           text not null default 'open' check (status in ('open','resolved')),
  created_at       timestamptz not null default now(),
  created_by       uuid,
  resolved_at      timestamptz,
  resolved_by      uuid,
  resolution_note  text
);
create index if not exists supplier_payment_holds_invoice_idx on public.supplier_payment_holds(invoice_id);
create index if not exists supplier_payment_holds_open_idx on public.supplier_payment_holds(status) where status = 'open';
alter table public.supplier_payment_holds enable row level security;
drop policy if exists staff_read on public.supplier_payment_holds;
drop policy if exists mgr_write on public.supplier_payment_holds;
create policy staff_read on public.supplier_payment_holds for select using (app.has_perm('payables.view') or app.has_perm('invoices.view') or app.is_staff());
create policy mgr_write on public.supplier_payment_holds for all using (app.has_perm('payables.manage') or app.can_write()) with check (app.has_perm('payables.manage') or app.can_write());

-- ── Credit notes ─────────────────────────────────────────────────────────
create table if not exists public.supplier_credit_notes (
  id            uuid primary key default gen_random_uuid(),
  supplier_id   uuid not null references public.suppliers(id) on delete cascade,
  invoice_id    uuid references public.supplier_invoices(id) on delete set null,
  amount_cents  int not null check (amount_cents > 0),
  reason        text not null,
  credit_date   date not null default current_date,
  created_by    uuid,
  created_at    timestamptz not null default now()
);
create index if not exists supplier_credit_notes_supplier_idx on public.supplier_credit_notes(supplier_id, credit_date desc);
alter table public.supplier_credit_notes enable row level security;
drop policy if exists staff_read on public.supplier_credit_notes;
drop policy if exists mgr_write on public.supplier_credit_notes;
create policy staff_read on public.supplier_credit_notes for select using (app.has_perm('payables.view') or app.is_staff());
create policy mgr_write on public.supplier_credit_notes for all using (app.has_perm('payables.manage') or app.can_write()) with check (app.has_perm('payables.manage') or app.can_write());

-- ── Supplier payments + allocation ──────────────────────────────────────
create table if not exists public.supplier_payments (
  id            uuid primary key default gen_random_uuid(),
  supplier_id   uuid not null references public.suppliers(id) on delete restrict,
  amount_cents  int not null check (amount_cents > 0),
  method        text not null default 'bank_transfer',
  reference     text,
  paid_at       timestamptz not null default now(),
  note          text,
  created_by    uuid
);
create index if not exists supplier_payments_supplier_idx on public.supplier_payments(supplier_id, paid_at desc);

create table if not exists public.supplier_payment_allocations (
  id            uuid primary key default gen_random_uuid(),
  payment_id    uuid not null references public.supplier_payments(id) on delete cascade,
  invoice_id    uuid not null references public.supplier_invoices(id) on delete restrict,
  amount_cents  int not null check (amount_cents > 0),
  unique (payment_id, invoice_id)
);
create index if not exists supplier_payment_allocations_invoice_idx on public.supplier_payment_allocations(invoice_id);

alter table public.supplier_payments enable row level security;
alter table public.supplier_payment_allocations enable row level security;
drop policy if exists staff_read on public.supplier_payments;
drop policy if exists mgr_write on public.supplier_payments;
create policy staff_read on public.supplier_payments for select using (app.has_perm('payables.view') or app.is_staff());
create policy mgr_write on public.supplier_payments for all using (app.has_perm('payables.record_payment') or app.can_write()) with check (app.has_perm('payables.record_payment') or app.can_write());
drop policy if exists staff_read on public.supplier_payment_allocations;
drop policy if exists mgr_write on public.supplier_payment_allocations;
create policy staff_read on public.supplier_payment_allocations for select using (app.has_perm('payables.view') or app.is_staff());
create policy mgr_write on public.supplier_payment_allocations for all using (app.has_perm('payables.record_payment') or app.can_write()) with check (app.has_perm('payables.record_payment') or app.can_write());

create or replace function app.invoice_outstanding_cents(p_invoice_id uuid) returns int
language sql stable set search_path = public, app as $fn$
  select greatest(0,
    (select si.total_cents from public.supplier_invoices si where si.id = p_invoice_id)
    - coalesce((select sum(spa.amount_cents) from public.supplier_payment_allocations spa where spa.invoice_id = p_invoice_id), 0)
    - coalesce((select sum(scn.amount_cents) from public.supplier_credit_notes scn where scn.invoice_id = p_invoice_id), 0)
  )::int
$fn$;

-- ── Three-way matching ───────────────────────────────────────────────────
create or replace function public.match_supplier_invoice(p_invoice_id uuid) returns jsonb
language plpgsql security definer set search_path = public, app as $fn$
declare
  v_qty_tol numeric; v_price_tol numeric;
  v_line record; v_po_price int; v_recv_qty numeric;
  v_qty_diff_pct numeric; v_price_diff_pct numeric;
  v_all_ok boolean := true; v_unmatched_amount int := 0;
  v_sitem_id uuid; v_old_price int;
begin
  if not (app.has_perm('invoices.match') or app.can_write()) then
    raise exception 'forbidden' using errcode = 'insufficient_privilege';
  end if;
  select qty_tolerance_pct, price_tolerance_pct into v_qty_tol, v_price_tol from public.purchasing_settings;
  v_qty_tol := coalesce(v_qty_tol, 2); v_price_tol := coalesce(v_price_tol, 1);

  update public.supplier_payment_holds
     set status = 'resolved', resolved_at = now(), resolution_note = 'superseded by re-match'
   where invoice_id = p_invoice_id and status = 'open';

  for v_line in
    select sil.id, sil.qty, sil.unit_cost_cents, sil.line_total_cents, sil.po_line_id, sil.inventory_item_id
      from public.supplier_invoice_lines sil where sil.invoice_id = p_invoice_id
  loop
    if v_line.po_line_id is null then
      v_all_ok := false;
      v_unmatched_amount := v_unmatched_amount + v_line.line_total_cents;
      insert into public.supplier_payment_holds (invoice_id, reason, amount_cents, created_by)
        values (p_invoice_id, 'Invoice line not linked to a purchase order — needs manual review', v_line.line_total_cents, app.jwt_sub());
      continue;
    end if;

    select pol.received_qty, pol.unit_cost_cents into v_recv_qty, v_po_price
      from public.purchase_order_lines pol where pol.id = v_line.po_line_id;

    v_qty_diff_pct := case when coalesce(v_recv_qty,0) > 0
      then abs(v_line.qty - v_recv_qty) / v_recv_qty * 100 else 100 end;
    v_price_diff_pct := case when coalesce(v_po_price,0) > 0
      then abs(v_line.unit_cost_cents - v_po_price) / v_po_price::numeric * 100 else 100 end;

    if v_qty_diff_pct > v_qty_tol then
      v_all_ok := false;
      v_unmatched_amount := v_unmatched_amount + v_line.line_total_cents;
      insert into public.supplier_payment_holds (invoice_id, reason, amount_cents, created_by)
        values (p_invoice_id,
          format('Quantity mismatch: invoiced %s vs received %s (%s%% difference)', v_line.qty, coalesce(v_recv_qty,0), round(v_qty_diff_pct,1)),
          v_line.line_total_cents, app.jwt_sub());
    elsif v_price_diff_pct > v_price_tol then
      v_all_ok := false;
      v_unmatched_amount := v_unmatched_amount + v_line.line_total_cents;
      insert into public.supplier_payment_holds (invoice_id, reason, amount_cents, created_by)
        values (p_invoice_id,
          format('Price variance: invoiced %s vs PO %s per unit (%s%% difference)', v_line.unit_cost_cents, coalesce(v_po_price,0), round(v_price_diff_pct,1)),
          v_line.line_total_cents, app.jwt_sub());
    else
      if v_line.inventory_item_id is not null then
        select si.id, si.current_price_cents into v_sitem_id, v_old_price
          from public.supplier_items si
          join public.supplier_invoices inv on inv.id = p_invoice_id
         where si.supplier_id = inv.supplier_id and si.inventory_item_id = v_line.inventory_item_id;
        if v_sitem_id is not null and v_old_price is distinct from v_line.unit_cost_cents then
          perform public.set_supplier_item_price(v_sitem_id, v_line.unit_cost_cents, 'invoice', p_invoice_id);
        end if;
      end if;
    end if;
  end loop;

  update public.supplier_invoices
     set status = case when v_all_ok then 'matched'::app.invoice_status else 'on_hold'::app.invoice_status end
   where id = p_invoice_id;

  return jsonb_build_object('matched', v_all_ok, 'unmatched_amount_cents', v_unmatched_amount);
end $fn$;
revoke all on function public.match_supplier_invoice(uuid) from public;
grant execute on function public.match_supplier_invoice(uuid) to authenticated, service_role;

create or replace function public.approve_supplier_invoice(p_invoice_id uuid) returns void
language plpgsql security definer set search_path = public, app as $fn$
begin
  if not (app.has_perm('invoices.match') or app.has_perm('payables.manage') or app.can_write()) then
    raise exception 'forbidden' using errcode = 'insufficient_privilege';
  end if;
  update public.supplier_invoices set status = 'approved' where id = p_invoice_id and status = 'matched';
  if not found then raise exception 'not_approvable' using errcode = 'check_violation'; end if;
end $fn$;
revoke all on function public.approve_supplier_invoice(uuid) from public;
grant execute on function public.approve_supplier_invoice(uuid) to authenticated, service_role;

create or replace function public.resolve_payment_hold(p_hold_id uuid, p_resolution_note text) returns void
language plpgsql security definer set search_path = public, app as $fn$
declare v_invoice uuid; v_remaining int;
begin
  if not (app.has_perm('payables.manage') or app.can_write()) then
    raise exception 'forbidden' using errcode = 'insufficient_privilege';
  end if;
  update public.supplier_payment_holds
     set status = 'resolved', resolved_at = now(), resolved_by = app.jwt_sub(),
         resolution_note = coalesce(nullif(trim(p_resolution_note), ''), 'resolved')
   where id = p_hold_id and status = 'open'
   returning invoice_id into v_invoice;
  if not found then raise exception 'hold_not_found_or_resolved' using errcode = 'check_violation'; end if;

  select count(*) into v_remaining from public.supplier_payment_holds
   where invoice_id = v_invoice and status = 'open';
  if v_remaining = 0 then
    update public.supplier_invoices set status = 'matched' where id = v_invoice and status = 'on_hold';
  end if;
end $fn$;
revoke all on function public.resolve_payment_hold(uuid, text) from public;
grant execute on function public.resolve_payment_hold(uuid, text) to authenticated, service_role;

create or replace function public.record_supplier_payment(
  p_supplier_id uuid, p_amount_cents int, p_method text, p_reference text,
  p_allocations jsonb, p_note text default null
) returns uuid
language plpgsql security definer set search_path = public, app as $fn$
declare
  v_payment_id uuid; v_alloc jsonb; v_inv uuid; v_amt int; v_sum int := 0;
  v_outstanding int; v_inv_supplier uuid;
begin
  if not (app.has_perm('payables.record_payment') or app.can_write()) then
    raise exception 'forbidden' using errcode = 'insufficient_privilege';
  end if;
  if coalesce(p_amount_cents, 0) <= 0 then raise exception 'bad_amount' using errcode = 'check_violation'; end if;

  insert into public.supplier_payments (supplier_id, amount_cents, method, reference, note, created_by)
  values (p_supplier_id, p_amount_cents, coalesce(nullif(p_method,''),'bank_transfer'), nullif(p_reference,''), p_note, app.jwt_sub())
  returning id into v_payment_id;

  for v_alloc in select value from jsonb_array_elements(coalesce(p_allocations, '[]'::jsonb)) as t(value) loop
    v_inv := (v_alloc->>'invoice_id')::uuid;
    v_amt := (v_alloc->>'amount_cents')::int;
    if coalesce(v_amt, 0) <= 0 then continue; end if;

    select si.supplier_id into v_inv_supplier from public.supplier_invoices si where si.id = v_inv;
    if v_inv_supplier is null then raise exception 'invoice_not_found: %', v_inv using errcode = 'foreign_key_violation'; end if;
    if v_inv_supplier is distinct from p_supplier_id then
      raise exception 'invoice_supplier_mismatch: %', v_inv using errcode = 'check_violation';
    end if;
    v_outstanding := app.invoice_outstanding_cents(v_inv);
    if v_amt > v_outstanding then
      raise exception 'allocation_exceeds_outstanding: % > %', v_amt, v_outstanding using errcode = 'check_violation';
    end if;

    insert into public.supplier_payment_allocations (payment_id, invoice_id, amount_cents)
    values (v_payment_id, v_inv, v_amt);
    v_sum := v_sum + v_amt;

    update public.supplier_invoices
       set status = case when app.invoice_outstanding_cents(v_inv) = 0 then 'paid'::app.invoice_status else 'partially_paid'::app.invoice_status end
     where id = v_inv;
  end loop;

  if v_sum > p_amount_cents then
    raise exception 'allocations_exceed_payment: % > %', v_sum, p_amount_cents using errcode = 'check_violation';
  end if;
  return v_payment_id;
end $fn$;
revoke all on function public.record_supplier_payment(uuid, int, text, text, jsonb, text) from public;
grant execute on function public.record_supplier_payment(uuid, int, text, text, jsonb, text) to authenticated, service_role;

create or replace function public.record_supplier_credit_note(
  p_supplier_id uuid, p_invoice_id uuid, p_amount_cents int, p_reason text
) returns uuid
language plpgsql security definer set search_path = public, app as $fn$
declare v_id uuid; v_inv_supplier uuid;
begin
  if not (app.has_perm('payables.manage') or app.can_write()) then
    raise exception 'forbidden' using errcode = 'insufficient_privilege';
  end if;
  if coalesce(p_amount_cents, 0) <= 0 then raise exception 'bad_amount' using errcode = 'check_violation'; end if;
  if coalesce(trim(p_reason), '') = '' then raise exception 'reason_required' using errcode = 'check_violation'; end if;
  if p_invoice_id is not null then
    select si.supplier_id into v_inv_supplier from public.supplier_invoices si where si.id = p_invoice_id;
    if v_inv_supplier is distinct from p_supplier_id then
      raise exception 'invoice_supplier_mismatch' using errcode = 'check_violation';
    end if;
  end if;
  insert into public.supplier_credit_notes (supplier_id, invoice_id, amount_cents, reason, created_by)
  values (p_supplier_id, p_invoice_id, p_amount_cents, p_reason, app.jwt_sub())
  returning id into v_id;
  if p_invoice_id is not null then
    update public.supplier_invoices
       set status = case when app.invoice_outstanding_cents(p_invoice_id) = 0 then 'paid'::app.invoice_status else status end
     where id = p_invoice_id and status not in ('paid','cancelled');
  end if;
  return v_id;
end $fn$;
revoke all on function public.record_supplier_credit_note(uuid, uuid, int, text) from public;
grant execute on function public.record_supplier_credit_note(uuid, uuid, int, text) to authenticated, service_role;

-- ── ONE authoritative accounts-payable ledger ───────────────────────────
create or replace function public.supplier_payable(p_supplier_id uuid default null)
returns table (
  supplier_id uuid, supplier_name text,
  invoiced_cents int, on_hold_cents int, approved_cents int,
  paid_cents int, credited_cents int, outstanding_cents int, overdue_cents int,
  open_invoices int, open_holds int
)
language plpgsql stable security definer set search_path = public, app as $fn$
begin
  if not (app.has_perm('payables.view') or app.has_perm('finance.view') or app.can_write()) then
    raise exception 'forbidden' using errcode = 'insufficient_privilege';
  end if;
  return query
    with inv as (
      select si.id, si.supplier_id as sup_id, si.total_cents, si.status, si.due_date,
             app.invoice_outstanding_cents(si.id) as outstanding
        from public.supplier_invoices si
       where si.status <> 'cancelled' and (p_supplier_id is null or si.supplier_id = p_supplier_id)
    ),
    hold as (
      select inv.sup_id, coalesce(sum(h.amount_cents),0)::int as sum_hold, count(*)::int as cnt_hold
        from public.supplier_payment_holds h
        join inv on inv.id = h.invoice_id
       where h.status = 'open'
       group by inv.sup_id
    ),
    paid as (
      select sp.supplier_id as sup_id, coalesce(sum(sp.amount_cents),0)::int as sum_paid
        from public.supplier_payments sp
       where p_supplier_id is null or sp.supplier_id = p_supplier_id
       group by sp.supplier_id
    ),
    credited as (
      select scn.supplier_id as sup_id, coalesce(sum(scn.amount_cents),0)::int as sum_credited
        from public.supplier_credit_notes scn
       where p_supplier_id is null or scn.supplier_id = p_supplier_id
       group by scn.supplier_id
    ),
    agg as (
      select inv.sup_id,
             coalesce(sum(inv.total_cents),0)::int as sum_invoiced,
             coalesce(sum(inv.total_cents) filter (where inv.status = 'approved'),0)::int as sum_approved,
             coalesce(sum(inv.outstanding),0)::int as sum_outstanding,
             coalesce(sum(inv.outstanding) filter (where inv.due_date is not null and inv.due_date < current_date),0)::int as sum_overdue,
             count(*) filter (where inv.outstanding > 0)::int as cnt_open
        from inv
       group by inv.sup_id
    )
    select s.id, s.name,
           coalesce(agg.sum_invoiced,0), coalesce(hold.sum_hold,0), coalesce(agg.sum_approved,0),
           coalesce(paid.sum_paid,0), coalesce(credited.sum_credited,0),
           coalesce(agg.sum_outstanding,0), coalesce(agg.sum_overdue,0),
           coalesce(agg.cnt_open,0), coalesce(hold.cnt_hold,0)
      from public.suppliers s
      left join agg on agg.sup_id = s.id
      left join hold on hold.sup_id = s.id
      left join paid on paid.sup_id = s.id
      left join credited on credited.sup_id = s.id
     where p_supplier_id is null or s.id = p_supplier_id
     order by coalesce(agg.sum_outstanding,0) desc;
end $fn$;
revoke all on function public.supplier_payable(uuid) from public;
grant execute on function public.supplier_payable(uuid) to authenticated, service_role;

create or replace function public.supplier_statement(p_supplier_id uuid, p_from date, p_to date)
returns table (txn_date date, kind text, reference text, amount_cents int, note text)
language plpgsql stable security definer set search_path = public, app as $fn$
begin
  if not (app.has_perm('payables.view') or app.has_perm('finance.view') or app.can_write()) then
    raise exception 'forbidden' using errcode = 'insufficient_privilege';
  end if;
  return query
    select si.invoice_date, 'invoice'::text, si.supplier_invoice_number, si.total_cents, si.notes
      from public.supplier_invoices si
     where si.supplier_id = p_supplier_id and si.status <> 'cancelled'
       and si.invoice_date >= p_from and si.invoice_date <= p_to
    union all
    select scn.credit_date, 'credit_note'::text, scn.reason, -scn.amount_cents, scn.reason
      from public.supplier_credit_notes scn
     where scn.supplier_id = p_supplier_id
       and scn.credit_date >= p_from and scn.credit_date <= p_to
    union all
    select sp.paid_at::date, 'payment'::text, coalesce(sp.reference, sp.method), -sp.amount_cents, sp.note
      from public.supplier_payments sp
     where sp.supplier_id = p_supplier_id
       and sp.paid_at::date >= p_from and sp.paid_at::date <= p_to
    order by 1;
end $fn$;
revoke all on function public.supplier_statement(uuid, date, date) from public;
grant execute on function public.supplier_statement(uuid, date, date) to authenticated, service_role;
