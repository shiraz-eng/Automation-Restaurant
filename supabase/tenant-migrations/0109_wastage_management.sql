-- ============================================================================
-- 0109 — Wastage management.
--
-- A waste entry records WHAT was wasted (ingredient, quantity in the unit it
-- was entered in and in the base unit), WHY (reason + note), WHEN, at WHICH
-- branch and WHO was responsible. It moves stock through the existing stock
-- ledger (reason 'spoilage'), so Finance (WASTE_RECORDED), costing reports and
-- the AI read it exactly as before; nothing else writes stock for waste.
--
--   pending  → approved  stock deducted once (ledger row), cost fixed at the
--              weighted-average cost of that moment
--   pending  → rejected  nothing moves
--   approved → reversed  stock put back once, at the same cost (the finance
--              event is a negative waste, see ledger_on_simple below)
--
-- Who: inventory.manage_waste / stock.adjust / inventory.manage / owner and
-- manager record and approve (their entries apply at once, as before);
-- kitchen.record_waste alone records entries that wait for approval.
--
-- Double counting: waste of food already deducted by an order's recipe (a
-- cooked dish sent back, a cooking error on a ticket) is recorded against
-- that order and is NEVER deducted again — it is "already consumed" and is
-- capped at what the order actually used of that ingredient.
--
-- Idempotency: a client request id (unique) makes a retried submit return
-- the first entry instead of recording it twice; status changes lock the row.
--
-- Expiry: there is no batch tracking, so an optional shelf life per
-- ingredient lets the app estimate (first in, first out over receipts) which
-- stock is getting old. It is an estimate and is labelled as one.
-- ============================================================================

-- ── 1. Waste entries ────────────────────────────────────────────────────────
create table if not exists public.waste_entries (
  id                    uuid primary key default gen_random_uuid(),
  request_id            uuid unique,
  branch_id             uuid references public.branches(id),
  inventory_item_id     uuid not null references public.inventory_items(id) on delete restrict,
  qty_base              numeric(14,3) not null check (qty_base > 0),
  entered_qty           numeric(14,3) not null check (entered_qty > 0),
  entered_unit          text not null check (char_length(entered_unit) between 1 and 40),
  reason                text not null check (reason in ('expiry', 'spoilage', 'preparation', 'cooking_error', 'overproduction', 'spillage', 'other')),
  note                  text check (char_length(note) <= 500),
  occurred_on           date not null,
  responsible_member_id uuid references public.memberships(id) on delete set null,
  order_id              uuid references public.orders(id) on delete set null,
  already_consumed      boolean not null default false,
  status                text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'reversed')),
  unit_cost_cents_base  numeric(14,4),
  cost_cents            bigint,
  stock_ledger_id       uuid references public.stock_ledger(id) on delete set null,
  reversal_ledger_id    uuid references public.stock_ledger(id) on delete set null,
  recorded_by           uuid,
  recorded_at           timestamptz not null default now(),
  decided_by            uuid,
  decided_at            timestamptz,
  decision_note         text check (char_length(decision_note) <= 500),
  reversed_by           uuid,
  reversed_at           timestamptz,
  reversal_reason       text check (char_length(reversal_reason) <= 500)
);
create index if not exists waste_entries_recorded_idx on public.waste_entries (recorded_at desc);
create index if not exists waste_entries_item_idx on public.waste_entries (inventory_item_id, recorded_at desc);
create index if not exists waste_entries_pending_idx on public.waste_entries (status) where status = 'pending';
create index if not exists waste_entries_order_idx on public.waste_entries (order_id, inventory_item_id) where order_id is not null;
create index if not exists waste_entries_ledger_idx on public.waste_entries (stock_ledger_id);
create index if not exists waste_entries_reversal_idx on public.waste_entries (reversal_ledger_id);

-- ── 2. Shelf life per ingredient (for expiry estimates) ─────────────────────
create table if not exists public.inventory_shelf_life (
  inventory_item_id uuid primary key references public.inventory_items(id) on delete cascade,
  shelf_life_days   int not null check (shelf_life_days between 1 and 3650),
  updated_at        timestamptz not null default now(),
  updated_by        uuid
);

-- ── 3. Permissions ──────────────────────────────────────────────────────────
create or replace function app.can_approve_waste() returns boolean
language sql stable set search_path = public, app as $fn$
  select coalesce(app.has_perm('inventory.manage_waste') or app.has_perm('stock.adjust')
                  or app.has_perm('inventory.manage') or app.can_write(), false)
$fn$;
create or replace function app.can_record_waste() returns boolean
language sql stable set search_path = public, app as $fn$
  select coalesce(app.can_approve_waste() or app.has_perm('kitchen.record_waste'), false)
$fn$;
create or replace function app.can_view_waste() returns boolean
language sql stable set search_path = public, app as $fn$
  select coalesce(app.can_record_waste() or app.has_perm('stock.history') or app.has_perm('inventory.view_cost'), false)
$fn$;
grant execute on function app.can_approve_waste(), app.can_record_waste(), app.can_view_waste() to authenticated, service_role;

alter table public.waste_entries enable row level security;
drop policy if exists staff_read on public.waste_entries;
create policy staff_read on public.waste_entries for select
  using (app.can_view_waste() and app.in_scope(branch_id));
revoke insert, update, delete on public.waste_entries from anon, authenticated;
grant select on public.waste_entries to authenticated;
grant all on public.waste_entries to service_role;

alter table public.inventory_shelf_life enable row level security;
drop policy if exists staff_read on public.inventory_shelf_life;
create policy staff_read on public.inventory_shelf_life for select
  using (app.has_perm('stock.view') or app.is_staff());
revoke insert, update, delete on public.inventory_shelf_life from anon, authenticated;
grant select on public.inventory_shelf_life to authenticated;
grant all on public.inventory_shelf_life to service_role;

-- ── 4. Units ────────────────────────────────────────────────────────────────
-- How many base units one entered unit is: the base unit itself (1), the
-- item's purchase unit (purchase_unit_to_base), or a metric relative of the
-- base unit (kg ↔ g, L ↔ ml). NULL = not convertible (rejected).
create or replace function app.metric_unit(p_unit text, out family text, out scale numeric)
language sql immutable as $fn$
  select case when u in ('mg') then 'weight' when u in ('g', 'gm', 'gram', 'grams') then 'weight'
              when u in ('kg', 'kgs', 'kilo', 'kilogram', 'kilograms') then 'weight'
              when u in ('ml', 'millilitre', 'milliliter') then 'volume'
              when u in ('l', 'ltr', 'litre', 'liter', 'litres', 'liters') then 'volume' end,
         case when u in ('mg') then 0.001 when u in ('g', 'gm', 'gram', 'grams') then 1
              when u in ('kg', 'kgs', 'kilo', 'kilogram', 'kilograms') then 1000
              when u in ('ml', 'millilitre', 'milliliter') then 1
              when u in ('l', 'ltr', 'litre', 'liter', 'litres', 'liters') then 1000 end
    from (select lower(trim(coalesce(p_unit, ''))) as u) s
$fn$;

create or replace function app.waste_unit_factor(p_item uuid, p_unit text) returns numeric
language plpgsql stable set search_path = public, app as $fn$
declare i public.inventory_items; u text := lower(trim(coalesce(p_unit, ''))); a record; b record;
begin
  select * into i from public.inventory_items where id = p_item;
  if not found then return null; end if;
  if u = '' or u = lower(trim(i.unit)) then return 1; end if;
  if i.purchase_unit_label is not null and u = lower(trim(i.purchase_unit_label)) then return i.purchase_unit_to_base; end if;
  select * into a from app.metric_unit(u);
  select * into b from app.metric_unit(i.unit);
  if a.family is not null and a.family = b.family then return a.scale / b.scale; end if;
  return null;
end $fn$;

-- ── 5. Recording, approving, rejecting, reversing ──────────────────────────
create or replace function app.waste_entry_json(p_id uuid) returns jsonb
language sql stable security definer set search_path = public, app as $fn$
  select to_jsonb(e) || jsonb_build_object('stock_qty', app.branch_qty(e.inventory_item_id, e.branch_id))
    from public.waste_entries e where e.id = p_id
$fn$;
revoke all on function app.waste_entry_json(uuid) from public;

-- Deduct a pending entry exactly once. Internal: callers check permissions.
create or replace function app.apply_waste_entry(p_id uuid, p_note text default null) returns void
language plpgsql security definer set search_path = public, app as $fn$
declare
  e public.waste_entries; v_cost numeric; v_ledger uuid; v_new numeric;
  v_prev text := current_setting('app.stock_branch', true);
begin
  select * into e from public.waste_entries where id = p_id for update;
  if not found then raise exception 'waste_entry_not_found' using errcode = 'no_data_found'; end if;
  if e.status <> 'pending' then raise exception 'waste_entry_already_%', e.status using errcode = 'check_violation'; end if;

  select cost_cents_per_base_unit into v_cost from public.inventory_items where id = e.inventory_item_id;
  if not e.already_consumed then
    perform set_config('app.stock_branch', e.branch_id::text, true);
    -- Lock this branch's stock row so two entries can't both pass the check.
    perform 1 from public.branch_stock where branch_id = e.branch_id and inventory_item_id = e.inventory_item_id for update;
    update app.inv set stock_qty = stock_qty - e.qty_base
     where id = e.inventory_item_id and stock_qty >= e.qty_base
     returning stock_qty into v_new;
    if not found then
      perform set_config('app.stock_branch', coalesce(v_prev, ''), true);
      raise exception 'insufficient_stock: %', e.inventory_item_id using errcode = 'check_violation';
    end if;
    insert into public.stock_ledger (inventory_item_id, branch_id, delta_qty, reason, note, unit_cost_cents_base)
    values (e.inventory_item_id, e.branch_id, -e.qty_base, 'spoilage',
            'Waste (' || replace(e.reason, '_', ' ') || ')' || coalesce(': ' || nullif(trim(e.note), ''), ''), v_cost)
    returning id into v_ledger;
    perform set_config('app.stock_branch', coalesce(v_prev, ''), true);
  end if;

  update public.waste_entries
     set status = 'approved', unit_cost_cents_base = v_cost, cost_cents = round(e.qty_base * coalesce(v_cost, 0))::bigint,
         stock_ledger_id = v_ledger, decided_by = app.jwt_sub(), decided_at = now(),
         decision_note = coalesce(nullif(trim(p_note), ''), decision_note)
   where id = p_id;
end $fn$;
revoke all on function app.apply_waste_entry(uuid, text) from public;

create or replace function public.record_waste_entry(
  p_inventory_item_id uuid, p_qty numeric, p_unit text, p_reason text,
  p_note text default null, p_occurred_on date default null,
  p_responsible_member_id uuid default null, p_order_id uuid default null,
  p_request_id uuid default null, p_branch_id uuid default null
) returns jsonb
language plpgsql security definer set search_path = public, app as $fn$
declare
  v_factor numeric; v_base numeric; v_branch uuid; v_today date := coalesce(app.business_day(now()), current_date);
  v_on date; v_member uuid; v_id uuid; v_used numeric; v_logged numeric;
begin
  if not app.can_record_waste() then raise exception 'forbidden' using errcode = 'insufficient_privilege'; end if;

  if p_request_id is not null then
    select id into v_id from public.waste_entries where request_id = p_request_id;
    if found then return app.waste_entry_json(v_id) || '{"duplicate": true}'::jsonb; end if;
  end if;

  if coalesce(p_qty, 0) <= 0 then raise exception 'bad_qty' using errcode = 'check_violation'; end if;
  if p_reason is null or p_reason not in ('expiry', 'spoilage', 'preparation', 'cooking_error', 'overproduction', 'spillage', 'other') then
    raise exception 'bad_reason' using errcode = 'check_violation';
  end if;
  if p_reason = 'other' and coalesce(trim(p_note), '') = '' then raise exception 'reason_required' using errcode = 'check_violation'; end if;
  if not exists (select 1 from public.inventory_items where id = p_inventory_item_id) then
    raise exception 'inventory_item_not_found' using errcode = 'foreign_key_violation';
  end if;
  v_factor := app.waste_unit_factor(p_inventory_item_id, p_unit);
  if v_factor is null then raise exception 'bad_unit' using errcode = 'check_violation'; end if;
  v_base := round(p_qty * v_factor, 3);
  if v_base <= 0 then raise exception 'bad_qty' using errcode = 'check_violation'; end if;

  v_on := coalesce(p_occurred_on, v_today);
  if v_on > v_today or v_on < v_today - 31 then raise exception 'bad_date' using errcode = 'check_violation'; end if;

  v_branch := coalesce(p_branch_id, app.stock_branch_id());
  if not app.branch_access(v_branch) then raise exception 'forbidden' using errcode = 'insufficient_privilege'; end if;

  v_member := coalesce(p_responsible_member_id, app.my_membership_id());
  if p_responsible_member_id is not null and not exists (select 1 from public.memberships where id = p_responsible_member_id) then
    raise exception 'bad_member' using errcode = 'foreign_key_violation';
  end if;

  -- Food an order already used: never deducted again, and no more than that order used.
  if p_order_id is not null then
    perform pg_advisory_xact_lock(hashtext('waste:' || p_order_id::text || ':' || p_inventory_item_id::text));
    select coalesce(-sum(delta_qty), 0) into v_used from public.stock_ledger
     where order_id = p_order_id and inventory_item_id = p_inventory_item_id and reason = 'order_deduction';
    if v_used <= 0 then raise exception 'not_used_by_order' using errcode = 'check_violation'; end if;
    select coalesce(sum(qty_base), 0) into v_logged from public.waste_entries
     where order_id = p_order_id and inventory_item_id = p_inventory_item_id and status in ('pending', 'approved');
    if v_logged + v_base > v_used then raise exception 'exceeds_order_usage' using errcode = 'check_violation'; end if;
  end if;

  begin
    insert into public.waste_entries
      (request_id, branch_id, inventory_item_id, qty_base, entered_qty, entered_unit, reason, note, occurred_on,
       responsible_member_id, order_id, already_consumed, recorded_by)
    values
      (p_request_id, v_branch, p_inventory_item_id, v_base, p_qty,
       coalesce(nullif(trim(p_unit), ''), (select unit from public.inventory_items where id = p_inventory_item_id)), p_reason,
       nullif(trim(p_note), ''), v_on, v_member, p_order_id, p_order_id is not null, app.jwt_sub())
    returning id into v_id;
  exception when unique_violation then
    -- The same request arrived twice at the same moment: return the first.
    select id into v_id from public.waste_entries where request_id = p_request_id;
    if v_id is null then raise; end if;
    return app.waste_entry_json(v_id) || '{"duplicate": true}'::jsonb;
  end;

  perform app.log_action('inventory.waste_recorded', 'waste_entries', v_id::text, null,
    jsonb_build_object('inventory_item_id', p_inventory_item_id, 'qty_base', v_base, 'entered', p_qty || ' ' || coalesce(p_unit, ''),
                       'reason', p_reason, 'order_id', p_order_id, 'branch_id', v_branch));

  if app.can_approve_waste() then perform app.apply_waste_entry(v_id, null); end if;
  return app.waste_entry_json(v_id);
end $fn$;
revoke all on function public.record_waste_entry(uuid, numeric, text, text, text, date, uuid, uuid, uuid, uuid) from public;
grant execute on function public.record_waste_entry(uuid, numeric, text, text, text, date, uuid, uuid, uuid, uuid) to authenticated, service_role;

create or replace function public.approve_waste_entry(p_id uuid, p_note text default null) returns jsonb
language plpgsql security definer set search_path = public, app as $fn$
declare v_branch uuid;
begin
  if not app.can_approve_waste() then raise exception 'forbidden' using errcode = 'insufficient_privilege'; end if;
  select branch_id into v_branch from public.waste_entries where id = p_id;
  if not found then raise exception 'waste_entry_not_found' using errcode = 'no_data_found'; end if;
  if not app.branch_access(v_branch) then raise exception 'forbidden' using errcode = 'insufficient_privilege'; end if;
  perform app.apply_waste_entry(p_id, p_note);
  perform app.log_action('inventory.waste_approved', 'waste_entries', p_id::text, null, jsonb_build_object('note', p_note));
  return app.waste_entry_json(p_id);
end $fn$;
revoke all on function public.approve_waste_entry(uuid, text) from public;
grant execute on function public.approve_waste_entry(uuid, text) to authenticated, service_role;

create or replace function public.reject_waste_entry(p_id uuid, p_note text) returns jsonb
language plpgsql security definer set search_path = public, app as $fn$
declare e public.waste_entries;
begin
  if not app.can_approve_waste() then raise exception 'forbidden' using errcode = 'insufficient_privilege'; end if;
  if coalesce(trim(p_note), '') = '' then raise exception 'reason_required' using errcode = 'check_violation'; end if;
  select * into e from public.waste_entries where id = p_id for update;
  if not found then raise exception 'waste_entry_not_found' using errcode = 'no_data_found'; end if;
  if not app.branch_access(e.branch_id) then raise exception 'forbidden' using errcode = 'insufficient_privilege'; end if;
  if e.status <> 'pending' then raise exception 'waste_entry_already_%', e.status using errcode = 'check_violation'; end if;
  update public.waste_entries set status = 'rejected', decided_by = app.jwt_sub(), decided_at = now(), decision_note = trim(p_note)
   where id = p_id;
  perform app.log_action('inventory.waste_rejected', 'waste_entries', p_id::text, null, jsonb_build_object('note', p_note));
  return app.waste_entry_json(p_id);
end $fn$;
revoke all on function public.reject_waste_entry(uuid, text) from public;
grant execute on function public.reject_waste_entry(uuid, text) to authenticated, service_role;

-- Put an approved entry's stock back, once, at the cost it was taken out at.
create or replace function public.reverse_waste_entry(p_id uuid, p_reason text) returns jsonb
language plpgsql security definer set search_path = public, app as $fn$
declare e public.waste_entries; v_ledger uuid; v_prev text := current_setting('app.stock_branch', true);
begin
  if not app.can_approve_waste() then raise exception 'forbidden' using errcode = 'insufficient_privilege'; end if;
  if coalesce(trim(p_reason), '') = '' then raise exception 'reason_required' using errcode = 'check_violation'; end if;
  select * into e from public.waste_entries where id = p_id for update;
  if not found then raise exception 'waste_entry_not_found' using errcode = 'no_data_found'; end if;
  if not app.branch_access(e.branch_id) then raise exception 'forbidden' using errcode = 'insufficient_privilege'; end if;
  if e.status <> 'approved' then raise exception 'waste_entry_not_reversible' using errcode = 'check_violation'; end if;

  if e.stock_ledger_id is not null then
    perform set_config('app.stock_branch', e.branch_id::text, true);
    perform 1 from public.branch_stock where branch_id = e.branch_id and inventory_item_id = e.inventory_item_id for update;
    update app.inv set stock_qty = stock_qty + e.qty_base where id = e.inventory_item_id;
    insert into public.stock_ledger (inventory_item_id, branch_id, delta_qty, reason, note, unit_cost_cents_base)
    values (e.inventory_item_id, e.branch_id, e.qty_base, 'spoilage', 'Waste reversed: ' || trim(p_reason), e.unit_cost_cents_base)
    returning id into v_ledger;
    perform set_config('app.stock_branch', coalesce(v_prev, ''), true);
  end if;

  update public.waste_entries
     set status = 'reversed', reversal_ledger_id = v_ledger, reversed_by = app.jwt_sub(), reversed_at = now(), reversal_reason = trim(p_reason)
   where id = p_id;
  perform app.log_action('inventory.waste_reversed', 'waste_entries', p_id::text, null,
    jsonb_build_object('reason', p_reason, 'qty_base', e.qty_base, 'stock_restored', e.stock_ledger_id is not null));
  return app.waste_entry_json(p_id);
end $fn$;
revoke all on function public.reverse_waste_entry(uuid, text) from public;
grant execute on function public.reverse_waste_entry(uuid, text) to authenticated, service_role;

-- The Inventory screen's "− waste" button and the AI's record_waste keep their
-- signature and guard, and now create a (spoilage) waste entry like everything else.
create or replace function public.record_ingredient_waste(
  p_inventory_item_id uuid, p_qty numeric, p_note text
) returns numeric
language plpgsql security definer set search_path = public, app as $fn$
declare r jsonb;
begin
  if not (app.has_perm('inventory.manage_waste') or app.has_perm('stock.adjust') or app.can_write()) then
    raise exception 'forbidden' using errcode = 'insufficient_privilege';
  end if;
  if coalesce(trim(p_note), '') = '' then raise exception 'reason_required' using errcode = 'check_violation'; end if;
  r := public.record_waste_entry(p_inventory_item_id, p_qty, null, 'spoilage', p_note);
  return (r ->> 'stock_qty')::numeric;
end $fn$;
revoke all on function public.record_ingredient_waste(uuid, numeric, text) from public;
grant execute on function public.record_ingredient_waste(uuid, numeric, text) to authenticated, service_role;

create or replace function public.set_shelf_life(p_inventory_item_id uuid, p_days int) returns void
language plpgsql security definer set search_path = public, app as $fn$
begin
  if not (app.has_perm('stock.update') or app.has_perm('inventory.manage') or app.can_write()) then
    raise exception 'forbidden' using errcode = 'insufficient_privilege';
  end if;
  if p_days is null then
    delete from public.inventory_shelf_life where inventory_item_id = p_inventory_item_id;
  elsif p_days between 1 and 3650 then
    insert into public.inventory_shelf_life (inventory_item_id, shelf_life_days, updated_at, updated_by)
    values (p_inventory_item_id, p_days, now(), app.jwt_sub())
    on conflict (inventory_item_id) do update set shelf_life_days = excluded.shelf_life_days, updated_at = now(), updated_by = excluded.updated_by;
  else
    raise exception 'bad_days' using errcode = 'check_violation';
  end if;
  perform app.log_action('inventory.shelf_life', 'inventory_items', p_inventory_item_id::text, null, jsonb_build_object('days', p_days));
end $fn$;
revoke all on function public.set_shelf_life(uuid, int) from public;
grant execute on function public.set_shelf_life(uuid, int) to authenticated, service_role;

-- ── 6. Finance: a reversed waste is a negative waste event ─────────────────
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
        -- Waste out is a cost (+1); waste put back (a reversal) takes it away again (−1).
        case when new.reason = 'spoilage' then (case when new.delta_qty > 0 then -1 else 1 end) else sign(new.delta_qty) end::smallint,
        round(abs(new.delta_qty) * coalesce(new.unit_cost_cents_base,
          (select cost_cents_per_base_unit from public.inventory_items where id = new.inventory_item_id), 0))::bigint,
        new.created_at, 'stock_ledger', new.id, null, new.order_id, null, null,
        jsonb_build_object('inventory_item_id', new.inventory_item_id, 'qty', new.delta_qty,
          'reason', new.reason, 'note', new.note, 'cost_estimated', new.unit_cost_cents_base is null));
    end if;
  end case;
  return null;
end $fn$;

-- Costing reports summed |waste|; a reversal must subtract, so sum −Δ instead.
do $mig$
declare fn record; def text; new_def text;
begin
  for fn in
    select p.oid from pg_proc p
     where p.pronamespace in ('public'::regnamespace, 'app'::regnamespace) and p.prokind = 'f'
       and p.prosrc like '%sum(abs(delta_qty * unit_cost_cents_base)) filter (where reason = ''spoilage'')%'
  loop
    def := pg_get_functiondef(fn.oid);
    new_def := replace(def, 'sum(abs(delta_qty * unit_cost_cents_base)) filter (where reason = ''spoilage'')',
                            'sum(-(delta_qty * unit_cost_cents_base)) filter (where reason = ''spoilage'')');
    if new_def <> def then execute new_def; end if;
  end loop;
end $mig$;

-- ── 7. The wastage report ───────────────────────────────────────────────────
-- One period, per ingredient, straight off the stock ledger (business days in
-- the restaurant's time zone). Stock at the end of the period is today's stock
-- minus every movement after it; opening = closing minus the period's
-- movements. Recorded waste (spoilage, net of reversals) is kept apart from
-- stock-count differences (unexplained variance). Waste of food an order had
-- already used is reported on its own and never subtracted from stock again.
-- Costs are left out (null) without inventory.view_cost. With no branch given it
-- covers the branches in view (the portal's branch selector, app.in_scope).
create or replace function public.wastage_report(p_from date, p_to date, p_branch uuid default null) returns jsonb
language plpgsql stable security definer set search_path = public, app as $fn$
declare
  v_tz text; v_min int; v_from timestamptz; v_to timestamptz; v_cost_ok boolean; v_out jsonb;
begin
  if not app.can_view_waste() then raise exception 'forbidden' using errcode = 'insufficient_privilege'; end if;
  if p_from is null or p_to is null or p_from > p_to or p_to - p_from > 400 then raise exception 'bad_range' using errcode = 'check_violation'; end if;
  if p_branch is not null and not app.branch_access(p_branch) then raise exception 'forbidden' using errcode = 'insufficient_privilege'; end if;
  v_cost_ok := coalesce(app.has_perm('inventory.view_cost') or app.can_write(), false);

  select coalesce(timezone, 'UTC'), coalesce(business_day_start_minutes, 0) into v_tz, v_min from public.business_settings where id;
  v_tz := coalesce(v_tz, 'UTC'); v_min := coalesce(v_min, 0);
  v_from := (p_from::timestamp + make_interval(mins => v_min)) at time zone v_tz;
  v_to   := ((p_to + 1)::timestamp + make_interval(mins => v_min)) at time zone v_tz;

  with led as (
    select l.*, coalesce(l.unit_cost_cents_base, i.cost_cents_per_base_unit, 0) as cost, l.unit_cost_cents_base is null as estimated
      from public.stock_ledger l join public.inventory_items i on i.id = l.inventory_item_id
     where l.created_at >= v_from
       and (case when p_branch is null then app.in_scope(l.branch_id) else l.branch_id = p_branch end)
  ),
  cur as (
    select bs.inventory_item_id, sum(bs.stock_qty) as qty from public.branch_stock bs
     where case when p_branch is null then app.in_scope(bs.branch_id) else bs.branch_id = p_branch end
     group by 1
  ),
  per as (
    select inventory_item_id,
      coalesce(sum(delta_qty) filter (where created_at >= v_to), 0) as after_qty,
      coalesce(sum(delta_qty) filter (where created_at < v_to), 0) as period_net,
      coalesce(sum(delta_qty) filter (where created_at < v_to and reason = 'restock'), 0) as receipts,
      coalesce(sum(delta_qty) filter (where created_at < v_to and reason = 'adjustment' and delta_qty > 0), 0) as adj_in,
      coalesce(-sum(delta_qty) filter (where created_at < v_to and reason = 'adjustment' and delta_qty < 0), 0) as adj_out,
      coalesce(-sum(delta_qty) filter (where created_at < v_to and reason = 'order_deduction'), 0) as usage,
      coalesce(-sum(delta_qty * cost) filter (where created_at < v_to and reason = 'order_deduction'), 0) as usage_value,
      coalesce(-sum(delta_qty) filter (where created_at < v_to and reason = 'spoilage'), 0) as waste,
      coalesce(-sum(delta_qty * cost) filter (where created_at < v_to and reason = 'spoilage'), 0) as waste_value,
      coalesce(sum(delta_qty) filter (where created_at < v_to and reason = 'stock_take'), 0) as stock_take,
      count(*) filter (where created_at < v_to and reason in ('spoilage', 'order_deduction') and estimated) as estimated_rows,
      count(*) filter (where created_at < v_to) as period_rows
      from led group by 1
  ),
  consumed as (   -- waste of food an order already used (no stock movement of its own)
    select e.inventory_item_id, sum(e.qty_base) as qty, sum(e.cost_cents) as value
      from public.waste_entries e
     where e.already_consumed and e.status = 'approved' and e.decided_at >= v_from and e.decided_at < v_to
       and (case when p_branch is null then app.in_scope(e.branch_id) else e.branch_id = p_branch end)
     group by 1
  ),
  items as (
    select i.id, i.name, i.unit,
           coalesce(c.qty, 0) - coalesce(p.after_qty, 0) as closing,
           coalesce(p.period_net, 0) as period_net, p.receipts, p.adj_in, p.adj_out, p.usage, p.usage_value,
           p.waste, p.waste_value, p.stock_take, p.estimated_rows,
           coalesce(k.qty, 0) as waste_after_use, coalesce(k.value, 0) as waste_after_use_value,
           i.cost_cents_per_base_unit as unit_cost
      from public.inventory_items i
      left join per p on p.inventory_item_id = i.id
      left join cur c on c.inventory_item_id = i.id
      left join consumed k on k.inventory_item_id = i.id
     where coalesce(p.period_rows, 0) > 0 or k.inventory_item_id is not null
  ),
  wrows as (      -- every waste movement of the period, with its entry's reason
    select l.inventory_item_id, l.delta_qty, l.cost, app.business_day(l.created_at) as day,
           coalesce(e1.reason, e2.reason, 'unclassified') as reason
      from led l
      left join public.waste_entries e1 on e1.stock_ledger_id = l.id
      left join public.waste_entries e2 on e2.reversal_ledger_id = l.id
     where l.reason = 'spoilage' and l.created_at < v_to
    union all
    select e.inventory_item_id, -e.qty_base, coalesce(e.unit_cost_cents_base, 0), app.business_day(e.decided_at), e.reason
      from public.waste_entries e
     where e.already_consumed and e.status = 'approved' and e.decided_at >= v_from and e.decided_at < v_to
       and (case when p_branch is null then app.in_scope(e.branch_id) else e.branch_id = p_branch end)
  )
  select jsonb_build_object(
    'from', p_from, 'to', p_to, 'branch_id', p_branch, 'costs_visible', v_cost_ok,
    'items', coalesce((select jsonb_agg(jsonb_build_object(
        'inventory_item_id', id, 'name', name, 'unit', unit,
        'opening_qty', closing - period_net, 'closing_qty', closing,
        'receipts_qty', coalesce(receipts, 0), 'adjust_in_qty', coalesce(adj_in, 0), 'adjust_out_qty', coalesce(adj_out, 0),
        'usage_qty', coalesce(usage, 0), 'waste_qty', coalesce(waste, 0), 'stock_take_qty', coalesce(stock_take, 0),
        'waste_after_use_qty', waste_after_use,
        'usage_value_cents', case when v_cost_ok then round(coalesce(usage_value, 0)) end,
        'waste_cost_cents', case when v_cost_ok then round(coalesce(waste_value, 0)) end,
        'waste_after_use_cost_cents', case when v_cost_ok then round(waste_after_use_value) end,
        'unit_cost_cents', case when v_cost_ok then unit_cost end,
        'estimated_cost_rows', coalesce(estimated_rows, 0)) order by name) from items), '[]'::jsonb),
    'daily', coalesce((select jsonb_agg(jsonb_build_object('day', day, 'events', n,
        'cost_cents', case when v_cost_ok then round(cost) end) order by day)
        from (select day, count(*) as n, -sum(delta_qty * cost) as cost from wrows group by day) d), '[]'::jsonb),
    'by_item_reason', coalesce((select jsonb_agg(jsonb_build_object('inventory_item_id', inventory_item_id, 'reason', reason,
        'qty', qty, 'cost_cents', case when v_cost_ok then round(cost) end))
        from (select inventory_item_id, reason, -sum(delta_qty) as qty, -sum(delta_qty * cost) as cost
                from wrows group by 1, 2) r), '[]'::jsonb)
  ) into v_out;
  return v_out;
end $fn$;
revoke all on function public.wastage_report(date, date, uuid) from public;
grant execute on function public.wastage_report(date, date, uuid) to authenticated, service_role;
