-- ============================================================================
-- Tenant delta 0005 — Phase 4: menu variants
-- ============================================================================

alter table public.menu_items add column if not exists description text;
alter table public.menu_items add column if not exists image_url text;
alter table public.menu_items alter column price_cents set default 0;

create table if not exists public.menu_variants (
  id                 uuid primary key default gen_random_uuid(),
  menu_item_id       uuid not null references public.menu_items(id) on delete cascade,
  name               text not null default 'Regular',
  price_cents        integer not null check (price_cents >= 0),
  sku                text,
  sort_order         int not null default 0,
  is_available       boolean not null default true,
  track_availability boolean not null default false,
  available_qty      int not null default 0,
  created_at         timestamptz not null default now()
);
create index if not exists menu_variants_item_idx on public.menu_variants(menu_item_id, sort_order);

alter table public.order_lines add column if not exists variant_id uuid references public.menu_variants(id) on delete set null;
alter table public.order_lines add column if not exists variant_name_snapshot text;

-- One "Regular" variant per existing item (idempotent).
insert into public.menu_variants (menu_item_id, name, price_cents, sort_order)
select i.id, 'Regular', i.price_cents, 0
from public.menu_items i
where not exists (select 1 from public.menu_variants v where v.menu_item_id = i.id);

alter table public.menu_variants enable row level security;
drop policy if exists staff_read on public.menu_variants;
drop policy if exists mgr_write on public.menu_variants;
drop policy if exists guest_read on public.menu_variants;
create policy staff_read on public.menu_variants for select using (app.is_staff());
create policy mgr_write on public.menu_variants for all using (app.can_write()) with check (app.can_write());
create policy guest_read on public.menu_variants for select using (is_available);

do $$ begin
  execute 'create trigger audit after insert or update or delete on public.menu_variants for each row execute function app.audit_row()';
exception when duplicate_object then null; end $$;

-- ── place_order with variant support ────────────────────────────────────────
create or replace function public.place_order(
  p_channel text, p_table_label text, p_customer_name text,
  p_tax_rate_bps integer, p_lines jsonb,
  p_discount_cents int default 0, p_promo_code text default null
) returns table (order_id uuid, order_number bigint, subtotal_cents int, discount_cents int, tax_cents int, total_cents int)
language plpgsql security definer set search_path = public, app as $$
declare
  v_order_id uuid; v_no bigint; v_sub int := 0; v_tax int; v_total int;
  v_line jsonb; v_qty int; v_lt int; v_comp record; v_need numeric; v_upd int;
  v_session_id uuid; v_disc int := greatest(0, coalesce(p_discount_cents, 0));
  v_variant_id uuid; v_item_id uuid; v_item_name text; v_variant_name text;
  v_price int; v_avail boolean;
begin
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'no_lines' using errcode = 'check_violation';
  end if;

  update public.order_counter set next_number = next_number + 1 where id returning next_number - 1 into v_no;

  if coalesce(p_table_label, '') <> '' then
    select id into v_session_id from public.table_sessions
     where table_label = p_table_label and status = 'open'
     order by opened_at desc limit 1;
    if v_session_id is null then
      insert into public.table_sessions (table_label) values (p_table_label) returning id into v_session_id;
    end if;
  end if;

  insert into public.orders (order_number, session_id, channel, table_label, customer_name, status)
  values (v_no, v_session_id, coalesce(nullif(p_channel,''),'dine_in')::app.order_channel, p_table_label, p_customer_name, 'pending')
  returning id into v_order_id;

  for v_line in select value from jsonb_array_elements(p_lines) as t(value) loop
    v_qty := coalesce((v_line->>'qty')::int, 0);
    if v_qty <= 0 then raise exception 'bad_qty' using errcode = 'check_violation'; end if;

    v_variant_id := nullif(v_line->>'variant_id', '')::uuid;
    if v_variant_id is not null then
      select v.id, v.menu_item_id, i.name, v.name, v.price_cents, (v.is_available and i.is_available)
        into v_variant_id, v_item_id, v_item_name, v_variant_name, v_price, v_avail
        from public.menu_variants v join public.menu_items i on i.id = v.menu_item_id
       where v.id = v_variant_id;
      if not found then raise exception 'variant_not_found: %', v_line->>'variant_id' using errcode = 'foreign_key_violation'; end if;
    else
      v_item_id := (v_line->>'menu_item_id')::uuid;
      select i.name, i.is_available, i.price_cents into v_item_name, v_avail, v_price
        from public.menu_items i where i.id = v_item_id;
      if not found then raise exception 'menu_item_not_found: %', v_line->>'menu_item_id' using errcode = 'foreign_key_violation'; end if;
      select v.id, v.name, v.price_cents, (v.is_available and v_avail)
        into v_variant_id, v_variant_name, v_price, v_avail
        from public.menu_variants v where v.menu_item_id = v_item_id
       order by v.sort_order, v.created_at limit 1;
    end if;

    if not coalesce(v_avail, false) then
      raise exception 'item_unavailable: %', coalesce(v_item_name, v_item_id::text) using errcode = 'check_violation';
    end if;

    v_lt := v_price * v_qty;
    v_sub := v_sub + v_lt;

    insert into public.order_lines
      (order_id, menu_item_id, variant_id, name_snapshot, variant_name_snapshot, unit_price_cents, qty, line_total_cents, modifiers)
    values
      (v_order_id, v_item_id, v_variant_id,
       v_item_name || case when v_variant_name is not null and v_variant_name <> 'Regular' then ' · ' || v_variant_name else '' end,
       v_variant_name, v_price, v_qty, v_lt, coalesce(v_line->'modifiers','[]'::jsonb));

    if v_variant_id is not null then
      update public.menu_variants
         set available_qty = greatest(0, available_qty - v_qty)
       where id = v_variant_id and track_availability;
    end if;

    for v_comp in select inventory_item_id, qty_per_unit from public.recipe_components where menu_item_id = v_item_id loop
      v_need := v_comp.qty_per_unit * v_qty;
      update public.inventory_items set stock_qty = stock_qty - v_need
       where id = v_comp.inventory_item_id and stock_qty >= v_need;
      get diagnostics v_upd = row_count;
      if v_upd = 0 then raise exception 'insufficient_stock: %', v_comp.inventory_item_id using errcode = 'check_violation'; end if;
      insert into public.stock_ledger (inventory_item_id, delta_qty, reason, order_id)
      values (v_comp.inventory_item_id, -v_need, 'order_deduction', v_order_id);
    end loop;
  end loop;

  if coalesce(p_promo_code, '') <> '' then
    v_disc := public.promo_discount(p_promo_code, v_sub);
  end if;
  v_disc := least(greatest(v_disc, 0), v_sub);
  v_tax := round((v_sub - v_disc)::numeric * coalesce(p_tax_rate_bps,0) / 10000)::int;
  v_total := v_sub - v_disc + v_tax;
  update public.orders set subtotal_cents = v_sub, discount_cents = v_disc, promo_code = nullif(p_promo_code, ''),
    tax_cents = v_tax, total_cents = v_total,
    status = 'in_kitchen', updated_at = now() where id = v_order_id;

  insert into public.outbox (topic, payload) values ('order.placed', jsonb_build_object(
    'order_id', v_order_id, 'order_number', v_no, 'total_cents', v_total, 'table_label', p_table_label));

  return query select v_order_id, v_no, v_sub, v_disc, v_tax, v_total;
end $$;
revoke all on function public.place_order(text, text, text, integer, jsonb, int, text) from public;
grant execute on function public.place_order(text, text, text, integer, jsonb, int, text) to authenticated, service_role, anon;
