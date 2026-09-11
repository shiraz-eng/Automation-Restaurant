-- 0018: a real modifier / add-on system.
--
-- Distinct from a variant: a variant is a different purchasable product
-- configuration (own price/SKU/stock, e.g. Coke 250ml vs 500ml). A modifier
-- is a customization or optional addition layered on top of whichever
-- variant was chosen (e.g. "Choose Size" required-single, "Toppings"
-- optional up to 3, "Add-ons" optional any number).
--
-- Before this, order_lines.modifiers was a JSONB column place_order()
-- accepted from the client with zero validation, no price impact, and no
-- schema to define groups/options against. This migration adds that schema
-- and rewrites place_order() so every modifier selection is re-priced and
-- re-validated (existence, availability, and each group's required/min/max)
-- entirely server-side — the client sends only option IDs, never a price
-- or name. Deal-component lines are unaffected; modifiers only apply to the
-- plain item/variant order line.

create type app.modifier_kind as enum ('required_single', 'optional_single', 'multi');

create table public.modifier_groups (
  id           uuid primary key default gen_random_uuid(),
  menu_item_id uuid not null references public.menu_items(id) on delete cascade,
  name         text not null,
  kind         app.modifier_kind not null default 'multi',
  min_select   int not null default 0,
  max_select   int,
  sort_order   int not null default 0,
  created_at   timestamptz not null default now(),
  check (kind <> 'required_single' or min_select >= 1),
  check (max_select is null or max_select >= min_select)
);
create index modifier_groups_item_idx on public.modifier_groups(menu_item_id, sort_order);

create table public.modifier_options (
  id           uuid primary key default gen_random_uuid(),
  group_id     uuid not null references public.modifier_groups(id) on delete cascade,
  name         text not null,
  price_cents  int not null default 0 check (price_cents >= 0),
  is_available boolean not null default true,
  sort_order   int not null default 0
);
create index modifier_options_group_idx on public.modifier_options(group_id, sort_order);

alter table public.modifier_groups enable row level security;
alter table public.modifier_options enable row level security;
create policy staff_read on public.modifier_groups for select using (app.has_perm('menu.view') or app.is_staff());
create policy mgr_write on public.modifier_groups for all using (app.has_perm('menu.update') or app.can_write()) with check (app.has_perm('menu.update') or app.can_write());
create policy staff_read on public.modifier_options for select using (app.has_perm('menu.view') or app.is_staff());
create policy mgr_write on public.modifier_options for all using (app.has_perm('menu.update') or app.can_write()) with check (app.has_perm('menu.update') or app.can_write());
create policy guest_read on public.modifier_groups for select using (true);
create policy guest_read on public.modifier_options for select using (true);

create trigger audit after insert or update or delete on public.modifier_groups for each row execute function app.audit_row();
create trigger audit after insert or update or delete on public.modifier_options for each row execute function app.audit_row();

create or replace function public.place_order(
  p_channel text, p_table_label text, p_customer_name text,
  p_tax_rate_bps integer, p_lines jsonb,
  p_discount_cents int default 0, p_promo_code text default null,
  p_customer_note text default null
) returns table (order_id uuid, order_number bigint, subtotal_cents int, discount_cents int, tax_cents int, total_cents int)
language plpgsql security definer set search_path = public, app as $$
declare
  v_order_id uuid; v_no bigint; v_sub int := 0; v_tax int; v_total int;
  v_line jsonb; v_qty int; v_lt int; v_comp record; v_need numeric; v_upd int;
  v_session_id uuid; v_disc int := greatest(0, coalesce(p_discount_cents, 0));
  v_variant_id uuid; v_item_id uuid; v_item_name text; v_variant_name text;
  v_price int; v_avail boolean; v_track boolean;
  v_deal_id uuid; v_dc record;
begin
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'no_lines' using errcode = 'check_violation';
  end if;

  update public.order_counter set next_number = next_number + 1 where id returning next_number - 1 into v_no;

  -- Attach to the table's open session; open one if there isn't a live tab.
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

    v_deal_id := nullif(v_line->>'deal_id', '')::uuid;

    if v_deal_id is not null then
      -- ── Deal / combo: one priced HEADER line + zero-priced COMPONENT lines ──
      select d.name, d.price_cents, d.track_availability,
             (d.is_available
              and (d.starts_at is null or d.starts_at <= now())
              and (d.ends_at   is null or d.ends_at   >= now())
              and (not d.track_availability or d.available_qty >= v_qty))
        into v_item_name, v_price, v_track, v_avail
        from public.deals d where d.id = v_deal_id;
      if not found then raise exception 'deal_not_found: %', v_deal_id using errcode = 'foreign_key_violation'; end if;
      if not coalesce(v_avail, false) then
        raise exception 'deal_unavailable: %', v_item_name using errcode = 'check_violation';
      end if;

      v_lt := v_price * v_qty;
      v_sub := v_sub + v_lt;
      insert into public.order_lines
        (order_id, deal_id, name_snapshot, unit_price_cents, qty, line_total_cents, modifiers, customer_note)
      values
        (v_order_id, v_deal_id, v_item_name, v_price, v_qty, v_lt, '[]'::jsonb,
         nullif(left(coalesce(v_line->>'note', ''), 500), ''));
      update public.deals set available_qty = available_qty - v_qty
       where id = v_deal_id and track_availability and available_qty >= v_qty;
      get diagnostics v_upd = row_count;
      if v_track and v_upd = 0 then
        raise exception 'deal_unavailable: %', v_item_name using errcode = 'check_violation';
      end if;

      for v_dc in select menu_item_id, variant_id, qty from public.deal_components where deal_id = v_deal_id loop
        if v_dc.variant_id is not null then
          select v.id, v.menu_item_id, i.name, v.name, v.track_availability, (v.is_available and i.is_available)
            into v_variant_id, v_item_id, v_item_name, v_variant_name, v_track, v_avail
            from public.menu_variants v join public.menu_items i on i.id = v.menu_item_id
           where v.id = v_dc.variant_id;
        else
          v_item_id := v_dc.menu_item_id;
          select i.name, i.is_available into v_item_name, v_avail
            from public.menu_items i where i.id = v_item_id;
          select v.id, v.name, v.track_availability, (v.is_available and v_avail)
            into v_variant_id, v_variant_name, v_track, v_avail
            from public.menu_variants v where v.menu_item_id = v_item_id
           order by v.sort_order, v.created_at limit 1;
        end if;
        if not coalesce(v_avail, false) then
          raise exception 'deal_item_unavailable: %', coalesce(v_item_name, '?') using errcode = 'check_violation';
        end if;
        insert into public.order_lines
          (order_id, deal_id, menu_item_id, variant_id, name_snapshot, variant_name_snapshot,
           unit_price_cents, qty, line_total_cents, modifiers)
        values
          (v_order_id, v_deal_id, v_item_id, v_variant_id,
           v_item_name || case when v_variant_name is not null and v_variant_name <> 'Regular' then ' · ' || v_variant_name else '' end,
           v_variant_name, 0, v_dc.qty * v_qty, 0, '[]'::jsonb);
        if v_variant_id is not null then
          update public.menu_variants set available_qty = available_qty - v_dc.qty * v_qty
           where id = v_variant_id and track_availability and available_qty >= v_dc.qty * v_qty;
          get diagnostics v_upd = row_count;
          if v_track and v_upd = 0 then
            raise exception 'deal_item_unavailable: %', coalesce(v_item_name, '?') using errcode = 'check_violation';
          end if;
        end if;
        for v_comp in select inventory_item_id, qty_per_unit from public.recipe_components where menu_item_id = v_item_id loop
          v_need := v_comp.qty_per_unit * v_dc.qty * v_qty;
          update public.inventory_items set stock_qty = stock_qty - v_need
           where id = v_comp.inventory_item_id and stock_qty >= v_need;
          get diagnostics v_upd = row_count;
          if v_upd = 0 then raise exception 'insufficient_stock: %', v_comp.inventory_item_id using errcode = 'check_violation'; end if;
          insert into public.stock_ledger (inventory_item_id, delta_qty, reason, order_id)
          values (v_comp.inventory_item_id, -v_need, 'order_deduction', v_order_id);
        end loop;
      end loop;

    else
    v_variant_id := nullif(v_line->>'variant_id', '')::uuid;
    if v_variant_id is not null then
      -- Explicit variant: price + availability come from the variant.
      select v.id, v.menu_item_id, i.name, v.name, v.price_cents, v.track_availability, (v.is_available and i.is_available)
        into v_variant_id, v_item_id, v_item_name, v_variant_name, v_price, v_track, v_avail
        from public.menu_variants v join public.menu_items i on i.id = v.menu_item_id
       where v.id = v_variant_id;
      if not found then raise exception 'variant_not_found: %', v_line->>'variant_id' using errcode = 'foreign_key_violation'; end if;
    else
      -- Legacy line: item id only. Use its default (first) variant if one exists.
      v_item_id := (v_line->>'menu_item_id')::uuid;
      select i.name, i.is_available, i.price_cents into v_item_name, v_avail, v_price
        from public.menu_items i where i.id = v_item_id;
      if not found then raise exception 'menu_item_not_found: %', v_line->>'menu_item_id' using errcode = 'foreign_key_violation'; end if;
      select v.id, v.name, v.price_cents, v.track_availability, (v.is_available and v_avail)
        into v_variant_id, v_variant_name, v_price, v_track, v_avail
        from public.menu_variants v where v.menu_item_id = v_item_id
       order by v.sort_order, v.created_at limit 1;
    end if;

    if not coalesce(v_avail, false) then
      raise exception 'item_unavailable: %', coalesce(v_item_name, v_item_id::text) using errcode = 'check_violation';
    end if;

    -- Modifiers: the client sends only option IDs, never a price or name.
    -- Every option is re-priced and re-validated here — belongs to this
    -- item, currently available, and each group's required/min/max is
    -- satisfied — before it can affect the total. Unknown or stale IDs are
    -- silently dropped rather than trusted.
    declare
      v_mod_ids uuid[] := array(
        select (x)::uuid from jsonb_array_elements_text(coalesce(v_line->'modifier_option_ids', '[]'::jsonb)) as x
      );
      v_mod_total int;
      v_mod_snapshot jsonb;
      v_grp record;
      v_grp_selected int;
    begin
      select coalesce(sum(mo.price_cents), 0),
             coalesce(jsonb_agg(jsonb_build_object('id', mo.id, 'name', mo.name, 'price_cents', mo.price_cents)
                                 order by mo.sort_order), '[]'::jsonb)
        into v_mod_total, v_mod_snapshot
        from public.modifier_options mo
        join public.modifier_groups mg on mg.id = mo.group_id
       where mo.id = any(v_mod_ids) and mo.is_available and mg.menu_item_id = v_item_id;

      for v_grp in select id, name, kind, min_select, max_select
                     from public.modifier_groups where menu_item_id = v_item_id loop
        select count(*) into v_grp_selected
          from public.modifier_options mo
         where mo.group_id = v_grp.id and mo.id = any(v_mod_ids) and mo.is_available;
        if v_grp_selected < v_grp.min_select then
          raise exception 'modifier_required: %', v_grp.name using errcode = 'check_violation';
        end if;
        if v_grp.max_select is not null and v_grp_selected > v_grp.max_select then
          raise exception 'modifier_too_many: %', v_grp.name using errcode = 'check_violation';
        end if;
      end loop;

      v_lt := (v_price + v_mod_total) * v_qty;
      v_sub := v_sub + v_lt;

      insert into public.order_lines
        (order_id, menu_item_id, variant_id, name_snapshot, variant_name_snapshot,
         unit_price_cents, qty, line_total_cents, modifiers, customer_note)
      values
        (v_order_id, v_item_id, v_variant_id,
         v_item_name || case when v_variant_name is not null and v_variant_name <> 'Regular' then ' · ' || v_variant_name else '' end,
         v_variant_name, v_price + v_mod_total, v_qty, v_lt, v_mod_snapshot,
         nullif(left(coalesce(v_line->>'note', ''), 500), ''));
    end;

    -- Variant availability counter — atomic, concurrency-safe.
    if v_variant_id is not null then
      update public.menu_variants
         set available_qty = available_qty - v_qty
       where id = v_variant_id and track_availability and available_qty >= v_qty;
      get diagnostics v_upd = row_count;
      if v_track and v_upd = 0 then
        raise exception 'item_unavailable: %', coalesce(v_item_name, v_item_id::text) using errcode = 'check_violation';
      end if;
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
    end if;
  end loop;

  if coalesce(p_promo_code, '') <> '' then
    v_disc := public.promo_discount(p_promo_code, v_sub);
  end if;
  v_disc := least(greatest(v_disc, 0), v_sub);
  v_tax := round((v_sub - v_disc)::numeric * coalesce(p_tax_rate_bps,0) / 10000)::int;
  v_total := v_sub - v_disc + v_tax;
  update public.orders set subtotal_cents = v_sub, discount_cents = v_disc, promo_code = nullif(p_promo_code, ''),
    tax_cents = v_tax, total_cents = v_total, tax_rate_bps = coalesce(p_tax_rate_bps, 0),
    customer_note = nullif(left(coalesce(p_customer_note, ''), 500), ''),
    status = 'in_kitchen', updated_at = now() where id = v_order_id;

  insert into public.outbox (topic, payload) values ('order.placed', jsonb_build_object(
    'order_id', v_order_id, 'order_number', v_no, 'total_cents', v_total, 'table_label', p_table_label));

  return query select v_order_id, v_no, v_sub, v_disc, v_tax, v_total;
end $$;
revoke all on function public.place_order(text, text, text, integer, jsonb, int, text, text) from public;
grant execute on function public.place_order(text, text, text, integer, jsonb, int, text, text) to authenticated, service_role, anon;
