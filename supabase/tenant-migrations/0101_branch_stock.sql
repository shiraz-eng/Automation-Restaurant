-- ============================================================================
-- 0101 — Multi-branch, phase 4: stock per branch.
--
-- Ingredients (inventory_items) stay shared definitions; how much of each a
-- branch holds lives in public.branch_stock. inventory_items.stock_qty is kept
-- as the TOTAL across branches (for organization-wide screens and reports).
--
-- Rather than rewriting the 20 stock and availability functions, they now read
-- and write through app.inv — the same columns as inventory_items, but with
-- stock_qty = the stock of "the branch being worked in" (app.stock_branch_id:
-- an explicit context, else the selected/request branch, else the default).
-- So a DHA sale deducts DHA's stock, its "enough stock?" checks look at DHA,
-- and a dish is available at DHA only if DHA can make it. Availability and
-- low-stock alerts are recalculated per branch; receiving a purchase order
-- always stocks THAT order's branch; a transfer moves stock between branches
-- without touching revenue or expenses.
--
-- Single-branch restaurants: one branch holds all stock — nothing changes.
-- ============================================================================

-- ── 1. Branch stock ─────────────────────────────────────────────────────────
create table if not exists public.branch_stock (
  branch_id         uuid not null references public.branches(id),
  inventory_item_id uuid not null references public.inventory_items(id) on delete cascade,
  stock_qty         numeric(14,3) not null default 0,
  updated_at        timestamptz not null default now(),
  primary key (branch_id, inventory_item_id)
);
insert into public.branch_stock (branch_id, inventory_item_id, stock_qty)
select app.default_branch_id(), i.id, coalesce(i.stock_qty, 0) from public.inventory_items i
on conflict do nothing;

alter table public.branch_stock enable row level security;
drop policy if exists staff_read on public.branch_stock;
create policy staff_read on public.branch_stock for select
  using ((app.has_perm('stock.view') or app.is_staff()) and app.in_scope(branch_id));
-- Written only by the stock functions and triggers below.

-- ── 2. Which branch's stock a statement works on ───────────────────────────
create or replace function app.stock_branch_id() returns uuid
language sql stable security definer set search_path = public, app as $fn$
  select coalesce(nullif(current_setting('app.stock_branch', true), '')::uuid,
                  app.request_branch_id(), app.default_branch_id())
$fn$;
grant execute on function app.stock_branch_id() to authenticated, anon, service_role;

create or replace function app.branch_qty(p_item uuid, p_branch uuid) returns numeric
language sql stable security definer set search_path = public, app as $fn$
  select coalesce((select stock_qty from public.branch_stock where inventory_item_id = p_item and branch_id = p_branch), 0)
$fn$;

-- ── 3. The branch view of ingredients (same columns, same order) ────────────
do $mig$
declare cols text; upd text; lhs text; rhs text;
begin
  select string_agg(case when attname = 'stock_qty'
                           then 'coalesce((select bs.stock_qty from public.branch_stock bs where bs.inventory_item_id = i.id and bs.branch_id = app.stock_branch_id()), 0)::numeric(14,3) as stock_qty'
                           else 'i.' || quote_ident(attname) end, ', ' order by attnum),
         string_agg(case when attname not in ('id', 'stock_qty') then quote_ident(attname) || ' = new.' || quote_ident(attname) end, ', ' order by attnum),
         string_agg(case when attname not in ('id', 'stock_qty') then 'i.' || quote_ident(attname) end, ', ' order by attnum),
         string_agg(case when attname not in ('id', 'stock_qty') then 'new.' || quote_ident(attname) end, ', ' order by attnum)
    into cols, upd, lhs, rhs
    from pg_attribute where attrelid = 'public.inventory_items'::regclass and attnum > 0 and not attisdropped;
  execute 'create or replace view app.inv as select ' || cols || ' from public.inventory_items i';

  execute format($f$
    create or replace function app.inv_write() returns trigger
    language plpgsql security definer set search_path = public, app as $body$
    declare v_b uuid := app.stock_branch_id();
    begin
      if tg_op = 'DELETE' then
        delete from public.inventory_items where id = old.id;
        return old;
      end if;
      if tg_op = 'INSERT' then
        insert into public.inventory_items select new.*;
        return new;
      end if;
      if new.stock_qty is distinct from old.stock_qty then
        insert into public.branch_stock (branch_id, inventory_item_id, stock_qty, updated_at)
        values (v_b, old.id, coalesce(new.stock_qty, 0), now())
        on conflict (branch_id, inventory_item_id) do update set stock_qty = excluded.stock_qty, updated_at = now();
        perform app.sync_stock_total(old.id);
      end if;
      -- Other columns only when they changed (no empty audit entries for a stock movement).
      update public.inventory_items i set %s where i.id = old.id and (%s) is distinct from (%s);
      return new;
    end $body$;$f$, upd, lhs, rhs);
end $mig$;

drop trigger if exists inv_write on app.inv;
create trigger inv_write instead of insert or update or delete on app.inv for each row execute function app.inv_write();

-- inventory_items.stock_qty = the total across branches.
create or replace function app.sync_stock_total(p_item uuid) returns void
language plpgsql security definer set search_path = public, app as $fn$
begin
  perform set_config('app.stock_total_sync', 'on', true);
  update public.inventory_items
     set stock_qty = coalesce((select sum(stock_qty) from public.branch_stock where inventory_item_id = p_item), 0)
   where id = p_item;
  perform set_config('app.stock_total_sync', 'off', true);
end $fn$;

-- A direct write to inventory_items (the Inventory page, imports): new stock goes to the
-- branch being worked in; a change to stock_qty is applied to that branch as a difference.
create or replace function app.inventory_items_stock_write() returns trigger
language plpgsql security definer set search_path = public, app as $fn$
declare v_b uuid := app.stock_branch_id();
begin
  if coalesce(current_setting('app.stock_total_sync', true), '') = 'on' then return new; end if;
  if tg_op = 'INSERT' then
    insert into public.branch_stock (branch_id, inventory_item_id, stock_qty)
    values (v_b, new.id, coalesce(new.stock_qty, 0))
    on conflict (branch_id, inventory_item_id) do update set stock_qty = excluded.stock_qty, updated_at = now();
    return new;
  end if;
  if new.stock_qty is distinct from old.stock_qty then
    insert into public.branch_stock (branch_id, inventory_item_id, stock_qty)
    values (v_b, new.id, coalesce(new.stock_qty, 0) - coalesce(old.stock_qty, 0))
    on conflict (branch_id, inventory_item_id) do update
      set stock_qty = public.branch_stock.stock_qty + (coalesce(new.stock_qty, 0) - coalesce(old.stock_qty, 0)), updated_at = now();
    new.stock_qty := coalesce((select sum(stock_qty) from public.branch_stock where inventory_item_id = new.id), 0);
  end if;
  return new;
end $fn$;
drop trigger if exists stock_write_after_insert on public.inventory_items;
create trigger stock_write_after_insert after insert on public.inventory_items
  for each row execute function app.inventory_items_stock_write();
drop trigger if exists stock_write_before_update on public.inventory_items;
create trigger stock_write_before_update before update of stock_qty on public.inventory_items
  for each row execute function app.inventory_items_stock_write();

-- ── 4. Availability per branch ──────────────────────────────────────────────
alter table public.product_availability add column if not exists branch_id uuid references public.branches(id);
update public.product_availability set branch_id = app.default_branch_id() where branch_id is null;
alter table public.product_availability alter column branch_id set not null;
drop index if exists public.product_availability_key_idx;
create unique index if not exists product_availability_branch_key
  on public.product_availability (branch_id, menu_item_id, variant_id) nulls not distinct;
-- Readers (the guest menu, the kitchen, staff) see the availability of the branch in use.
drop policy if exists branch_wall on public.product_availability;
create policy branch_wall on public.product_availability as restrictive for select
  using (branch_id = app.stock_branch_id());

create or replace view app.pa as
  select * from public.product_availability where branch_id = app.stock_branch_id();

create or replace function app.apply_product_availability_result(
  p_menu_item_id uuid, p_variant_id uuid, p_tracked boolean, p_status text, p_producible numeric,
  p_bottleneck uuid, p_reason text, p_trigger_type text, p_trigger_reference text, p_actor text
) returns void
language plpgsql security definer set search_path = public, app as $fn$
declare v_prev record; v_b uuid := app.stock_branch_id();
begin
  if not p_tracked then
    delete from public.product_availability
     where branch_id = v_b and menu_item_id = p_menu_item_id and variant_id is not distinct from p_variant_id;
    return;
  end if;
  select status, producible_qty into v_prev from public.product_availability
   where branch_id = v_b and menu_item_id = p_menu_item_id and variant_id is not distinct from p_variant_id;
  insert into public.product_availability
    (branch_id, menu_item_id, variant_id, status, producible_qty, bottleneck_inventory_item_id, reason, updated_at)
  values (v_b, p_menu_item_id, p_variant_id, p_status, p_producible, p_bottleneck, p_reason, now())
  on conflict (branch_id, menu_item_id, variant_id) do update set
    status = excluded.status, producible_qty = excluded.producible_qty,
    bottleneck_inventory_item_id = excluded.bottleneck_inventory_item_id, reason = excluded.reason, updated_at = now();
  if v_prev is null or v_prev.status is distinct from p_status or v_prev.producible_qty is distinct from p_producible then
    insert into public.availability_audit_log
      (menu_item_id, variant_id, previous_status, new_status, previous_producible_qty, new_producible_qty,
       bottleneck_inventory_item_id, reason, trigger_type, trigger_reference, actor)
    values (p_menu_item_id, p_variant_id, v_prev.status, p_status, v_prev.producible_qty, p_producible,
            p_bottleneck, p_reason, p_trigger_type, p_trigger_reference, p_actor);
    perform app.log_action('availability.changed', 'menu_items', p_menu_item_id::text, null,
      jsonb_build_object('variant_id', p_variant_id, 'status', p_status, 'producible_qty', p_producible, 'reason', p_reason, 'branch_id', v_b));
  end if;
end $fn$;

-- The stock and availability functions read and write the branch view.
do $mig$
declare fn record; def text; new_def text;
begin
  for fn in
    select p.oid, p.proname from pg_proc p
     where p.pronamespace in ('public'::regnamespace, 'app'::regnamespace) and p.prokind = 'f'
       and p.proname in ('adjust_stock', 'place_order', 'receive_purchase_order', 'receive_purchase_order_line',
                         'record_dish_waste', 'record_ingredient_waste', 'submit_stock_count', 'compute_product_capacity',
                         'recalc_priority_allocation', 'get_product_availability_detail', 'deal_availability',
                         'guard_order_line_availability', 'recalc_product_availability', 'recalc_products_for_ingredient',
                         'on_modifier_option_availability_change', 'on_modifier_recipe_components_change')
  loop
    def := pg_get_functiondef(fn.oid);
    new_def := regexp_replace(def, 'public\.inventory_items\M', 'app.inv', 'g');
    new_def := regexp_replace(new_def, 'public\.product_availability\M', 'app.pa', 'g');
    if new_def <> def then execute new_def; end if;
  end loop;
end $mig$;

-- ── 5. Recalculate a branch when its stock changes; low stock per branch ────
drop trigger if exists recalc_availability_on_stock_change on public.inventory_items;
drop trigger if exists sync_low_stock_event on public.inventory_items;
drop index if exists public.low_stock_events_one_open_idx;
create unique index if not exists low_stock_events_one_open_per_branch
  on public.low_stock_events (inventory_item_id, branch_id) where status = 'open';

create or replace function app.on_branch_stock_change() returns trigger
language plpgsql security definer set search_path = public, app as $fn$
declare v_prev text := current_setting('app.stock_branch', true); v_type text; v_min numeric; v_open uuid;
begin
  if tg_op = 'UPDATE' and new.stock_qty is not distinct from old.stock_qty then return new; end if;
  perform set_config('app.stock_branch', new.branch_id::text, true);
  -- Low stock, per branch, against the ingredient's reorder level.
  select min_threshold into v_min from public.inventory_items where id = new.inventory_item_id;
  select id into v_open from public.low_stock_events
   where inventory_item_id = new.inventory_item_id and branch_id = new.branch_id and status = 'open';
  if v_min is not null and new.stock_qty <= v_min then
    if v_open is null then
      insert into public.low_stock_events (inventory_item_id, branch_id, stock_at_open, threshold_at_open)
      values (new.inventory_item_id, new.branch_id, new.stock_qty, v_min);
    end if;
  elsif v_open is not null then
    update public.low_stock_events set status = 'resolved', resolved_at = now() where id = v_open;
  end if;
  -- Availability of the dishes that use it, in this branch.
  v_type := case when tg_op = 'INSERT' or new.stock_qty > old.stock_qty then 'inventory_restock' else 'inventory_consumption' end;
  if app.priority_allocation_on() then
    perform app.recalc_priority_allocation(v_type, new.inventory_item_id::text, array[new.inventory_item_id]);
  else
    perform app.recalc_products_for_ingredient(new.inventory_item_id, v_type, null);
  end if;
  perform set_config('app.stock_branch', coalesce(v_prev, ''), true);
  return new;
end $fn$;
drop trigger if exists on_branch_stock_change on public.branch_stock;
create trigger on_branch_stock_change after insert or update of stock_qty on public.branch_stock
  for each row execute function app.on_branch_stock_change();

-- A changed reorder level re-checks every branch.
create or replace function app.on_threshold_change() returns trigger
language plpgsql security definer set search_path = public, app as $fn$
begin
  if new.min_threshold is distinct from old.min_threshold then
    update public.branch_stock set updated_at = now(), stock_qty = stock_qty where inventory_item_id = new.id;
    -- (a no-op stock update does not fire the stock trigger, so check explicitly)
    insert into public.low_stock_events (inventory_item_id, branch_id, stock_at_open, threshold_at_open)
    select bs.inventory_item_id, bs.branch_id, bs.stock_qty, new.min_threshold from public.branch_stock bs
     where bs.inventory_item_id = new.id and new.min_threshold is not null and bs.stock_qty <= new.min_threshold
       and not exists (select 1 from public.low_stock_events l where l.inventory_item_id = bs.inventory_item_id and l.branch_id = bs.branch_id and l.status = 'open');
    update public.low_stock_events l set status = 'resolved', resolved_at = now()
      from public.branch_stock bs
     where l.inventory_item_id = new.id and l.status = 'open' and bs.inventory_item_id = l.inventory_item_id and bs.branch_id = l.branch_id
       and (new.min_threshold is null or bs.stock_qty > new.min_threshold);
  end if;
  return new;
end $fn$;
drop trigger if exists on_threshold_change on public.inventory_items;
create trigger on_threshold_change after update of min_threshold on public.inventory_items
  for each row execute function app.on_threshold_change();

-- Reorder emails list each branch's low stock (the cron runs without a branch).
do $mig$
declare def text := pg_get_functiondef('public.pending_low_stock_reorders()'::regprocedure); before text;
begin
  before := def;
  def := replace(def, 'select lse.id, ii.id, ii.name, ii.unit,
           ii.stock_qty, ii.min_threshold, ii.target_stock_qty,',
    'select lse.id, ii.id,
           ii.name || case when (select count(*) from public.branches where status = ''active'') > 1
                           then '' — '' || (select b.name from public.branches b where b.id = lse.branch_id) else '''' end,
           ii.unit,
           app.branch_qty(ii.id, lse.branch_id), ii.min_threshold, ii.target_stock_qty,');
  def := replace(def, '- ii.stock_qty),', '- app.branch_qty(ii.id, lse.branch_id)),');
  if def = before or position('ii.stock_qty' in def) > 0 then
    raise exception '0101: unexpected shape of pending_low_stock_reorders()';
  end if;
  execute def;
end $mig$;

-- Stock rows and alerts belong to the branch whose stock moved.
create or replace function app.fill_stock_branch() returns trigger
language plpgsql security definer set search_path = public, app as $fn$
begin
  if new.branch_id is null then new.branch_id := app.stock_branch_id(); end if;
  return new;
end $fn$;
drop trigger if exists aa_fill_stock_branch on public.stock_ledger;
create trigger aa_fill_stock_branch before insert on public.stock_ledger for each row execute function app.fill_stock_branch();

-- ── 6. Receiving stocks the purchase order's own branch ─────────────────────
do $mig$
begin
  if to_regprocedure('app._receive_purchase_order_impl(uuid)') is null then
    alter function public.receive_purchase_order(uuid) set schema app;
    alter function app.receive_purchase_order(uuid) rename to _receive_purchase_order_impl;
  end if;
  if to_regprocedure('app._receive_purchase_order_line_impl(uuid, numeric, numeric, text)') is null then
    alter function public.receive_purchase_order_line(uuid, numeric, numeric, text) set schema app;
    alter function app.receive_purchase_order_line(uuid, numeric, numeric, text) rename to _receive_purchase_order_line_impl;
  end if;
end $mig$;

create or replace function public.receive_purchase_order(p_po_id uuid) returns void
language plpgsql security definer set search_path = public, app as $fn$
declare v_b uuid; v_prev text := current_setting('app.stock_branch', true);
begin
  select branch_id into v_b from public.purchase_orders where id = p_po_id;
  if v_b is not null and not app.branch_access(v_b) then
    raise exception 'forbidden: this purchase order belongs to another branch' using errcode = 'insufficient_privilege';
  end if;
  perform set_config('app.stock_branch', coalesce(v_b::text, ''), true);
  perform app._receive_purchase_order_impl(p_po_id);
  perform set_config('app.stock_branch', coalesce(v_prev, ''), true);
end $fn$;

create or replace function public.receive_purchase_order_line(
  p_line_id uuid, p_qty numeric, p_rejected_qty numeric default 0, p_reject_reason text default null
) returns void
language plpgsql security definer set search_path = public, app as $fn$
declare v_b uuid; v_prev text := current_setting('app.stock_branch', true);
begin
  select po.branch_id into v_b from public.purchase_order_lines l join public.purchase_orders po on po.id = l.purchase_order_id where l.id = p_line_id;
  if v_b is not null and not app.branch_access(v_b) then
    raise exception 'forbidden: this purchase order belongs to another branch' using errcode = 'insufficient_privilege';
  end if;
  perform set_config('app.stock_branch', coalesce(v_b::text, ''), true);
  perform app._receive_purchase_order_line_impl(p_line_id, p_qty, p_rejected_qty, p_reject_reason);
  perform set_config('app.stock_branch', coalesce(v_prev, ''), true);
end $fn$;
revoke all on function public.receive_purchase_order(uuid) from public;
revoke all on function public.receive_purchase_order_line(uuid, numeric, numeric, text) from public;
grant execute on function public.receive_purchase_order(uuid) to authenticated, service_role;
grant execute on function public.receive_purchase_order_line(uuid, numeric, numeric, text) to authenticated, service_role;

-- ── 7. Transfers between branches (never revenue or expense) ────────────────
create or replace function public.transfer_stock(
  p_inventory_item_id uuid, p_from_branch uuid, p_to_branch uuid, p_qty numeric, p_note text default null
) returns uuid
language plpgsql security definer set search_path = public, app as $fn$
declare v_transfer uuid := gen_random_uuid(); v_have numeric; v_cost numeric; v_name text; v_prev text := current_setting('app.stock_branch', true);
begin
  if not (app.has_perm('stock.update') or app.has_perm('inventory.manage') or app.can_write()) then
    raise exception 'forbidden' using errcode = 'insufficient_privilege';
  end if;
  if not app.branch_access(p_from_branch) then
    raise exception 'forbidden: you cannot send stock from that branch' using errcode = 'insufficient_privilege';
  end if;
  if p_from_branch = p_to_branch then raise exception 'same_branch' using errcode = 'check_violation'; end if;
  if coalesce(p_qty, 0) <= 0 then raise exception 'bad_qty' using errcode = 'check_violation'; end if;
  if not exists (select 1 from public.branches where id = p_to_branch and status = 'active') then
    raise exception 'branch_not_active' using errcode = 'check_violation';
  end if;
  select name, cost_cents_per_base_unit into v_name, v_cost from public.inventory_items where id = p_inventory_item_id;
  if not found then raise exception 'item_not_found' using errcode = 'no_data_found'; end if;
  v_have := app.branch_qty(p_inventory_item_id, p_from_branch);
  if v_have < p_qty then
    raise exception 'not_enough_stock: % has % of %', (select name from public.branches where id = p_from_branch), v_have, v_name
      using errcode = 'check_violation';
  end if;

  perform set_config('app.stock_branch', p_from_branch::text, true);
  update app.inv set stock_qty = stock_qty - p_qty where id = p_inventory_item_id;
  insert into public.stock_ledger (inventory_item_id, branch_id, delta_qty, reason, note, unit_cost_cents_base)
  values (p_inventory_item_id, p_from_branch, -p_qty, 'adjustment',
          'Transfer to ' || (select name from public.branches where id = p_to_branch) || coalesce(' — ' || nullif(trim(p_note), ''), '') || ' [' || v_transfer || ']', v_cost);

  perform set_config('app.stock_branch', p_to_branch::text, true);
  update app.inv set stock_qty = stock_qty + p_qty where id = p_inventory_item_id;
  insert into public.stock_ledger (inventory_item_id, branch_id, delta_qty, reason, note, unit_cost_cents_base)
  values (p_inventory_item_id, p_to_branch, p_qty, 'adjustment',
          'Transfer from ' || (select name from public.branches where id = p_from_branch) || coalesce(' — ' || nullif(trim(p_note), ''), '') || ' [' || v_transfer || ']', v_cost);

  perform set_config('app.stock_branch', coalesce(v_prev, ''), true);
  perform app.log_action('stock.transferred', 'inventory_items', p_inventory_item_id::text, null,
    jsonb_build_object('from', p_from_branch, 'to', p_to_branch, 'qty', p_qty, 'transfer', v_transfer, 'note', p_note));
  return v_transfer;
end $fn$;
revoke all on function public.transfer_stock(uuid, uuid, uuid, numeric, text) from public;
grant execute on function public.transfer_stock(uuid, uuid, uuid, numeric, text) to authenticated, service_role;

-- Stock in the branch being viewed, for the Inventory screen.
create or replace function public.branch_stock_levels() returns table (inventory_item_id uuid, branch_id uuid, stock_qty numeric)
language sql stable security definer set search_path = public, app as $fn$
  select bs.inventory_item_id, bs.branch_id, bs.stock_qty from public.branch_stock bs
   where (app.has_perm('stock.view') or app.is_staff()) and app.in_scope(bs.branch_id)
$fn$;
revoke all on function public.branch_stock_levels() from public;
grant execute on function public.branch_stock_levels() to authenticated, service_role;

-- Recompute every branch's availability once, from its own stock.
do $mig$
declare b record; prev text := current_setting('app.stock_branch', true);
begin
  for b in select id from public.branches where status = 'active' loop
    perform set_config('app.stock_branch', b.id::text, true);
    begin
      perform public.recalculate_all_product_availability();
    exception when others then
      raise notice '0101: availability will refresh on the next stock change (%)', sqlerrm;
    end;
  end loop;
  perform set_config('app.stock_branch', coalesce(prev, ''), true);
end $mig$;
