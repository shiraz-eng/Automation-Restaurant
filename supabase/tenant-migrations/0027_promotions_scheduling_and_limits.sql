-- 0027: Promotions v2 — happy-hour scheduling, usage limits with redemption
-- tracking, and a promotion_performance() analytics RPC. Manager
-- authorization + discount reasons for manual discounts already existed
-- (apply_order_discount() has always required orders.apply_discount and
-- logged a reason to order_adjustments) — this migration is additive to
-- that, not a replacement.

alter table public.promotions add column if not exists days_of_week smallint[]; -- 0=Sunday..6=Saturday; null = every day
alter table public.promotions add column if not exists start_time time;        -- null = no lower bound
alter table public.promotions add column if not exists end_time time;          -- null = no upper bound
alter table public.promotions add column if not exists usage_limit_total int;
alter table public.promotions add column if not exists usage_count int not null default 0;
do $$ begin
  if not exists (
    select 1 from pg_constraint where conname = 'promotions_usage_limit_total_check'
  ) then
    alter table public.promotions
      add constraint promotions_usage_limit_total_check
      check (usage_limit_total is null or usage_limit_total > 0);
  end if;
end $$;

-- One row per successful promo-code redemption. Written only by
-- place_order() (security definer) at the point usage_count is bumped.
create table if not exists public.promotion_redemptions (
  id            uuid primary key default gen_random_uuid(),
  promotion_id  uuid not null references public.promotions(id) on delete cascade,
  order_id      uuid references public.orders(id) on delete set null,
  discount_cents int not null,
  redeemed_at   timestamptz not null default now()
);
create index if not exists promotion_redemptions_promo_idx on public.promotion_redemptions(promotion_id, redeemed_at desc);
alter table public.promotion_redemptions enable row level security;
drop policy if exists staff_read on public.promotion_redemptions;
create policy staff_read on public.promotion_redemptions for select using (app.has_perm('menu.view') or app.is_staff());

-- promo_discount() (extended with schedule + usage-limit checks) and the
-- new promotion_performance() analytics RPC:
create or replace function public.promo_discount(p_code text, p_subtotal_cents int)
returns int language sql stable security definer set search_path = public, app as $fn$
  select coalesce((
    select case
      when p.kind = 'percent' then (p_subtotal_cents * coalesce(p.value_bps, 0) / 10000)
      else least(coalesce(p.value_cents, 0), p_subtotal_cents)
    end
    from public.promotions p
    where lower(p.code) = lower(p_code)
      and p.active
      and p_subtotal_cents >= p.min_subtotal_cents
      and (p.starts_at is null or p.starts_at <= now())
      and (p.ends_at is null or p.ends_at >= now())
      and (p.usage_limit_total is null or p.usage_count < p.usage_limit_total)
      and (p.days_of_week is null or extract(
             dow from (now() at time zone coalesce((select timezone from public.business_settings where id), 'UTC'))
           )::smallint = any(p.days_of_week))
      and (p.start_time is null or
           (now() at time zone coalesce((select timezone from public.business_settings where id), 'UTC'))::time >= p.start_time)
      and (p.end_time is null or
           (now() at time zone coalesce((select timezone from public.business_settings where id), 'UTC'))::time <= p.end_time)
    limit 1
  ), 0);
$fn$;
grant execute on function public.promo_discount(text, int) to authenticated, service_role, anon;

-- Per-promotion redemption count, total discount given and total revenue of
-- the orders it was applied to, over an optional window (both bounds null =
-- all time). Same authoritative-calc-layer principle as period_profitability
-- etc: this is the one place that answers "how is this promo doing" for
-- both the Promotions page and the AI assistant.
create or replace function public.promotion_performance(p_from timestamptz default null, p_to timestamptz default null)
returns table (
  promotion_id uuid, name text, code text, kind app.promo_kind,
  redemptions bigint, total_discount_cents bigint, total_order_revenue_cents bigint,
  usage_limit_total int, usage_count int
)
language plpgsql stable security definer set search_path = public, app as $fn$
begin
  if not app.has_perm('menu.view') then
    raise exception 'forbidden' using errcode = 'insufficient_privilege';
  end if;
  return query
    select p.id, p.name, p.code, p.kind,
           count(r.id)::bigint,
           coalesce(sum(r.discount_cents), 0)::bigint,
           coalesce(sum(o.total_cents), 0)::bigint,
           p.usage_limit_total, p.usage_count
      from public.promotions p
      left join public.promotion_redemptions r
        on r.promotion_id = p.id
       and (p_from is null or r.redeemed_at >= p_from)
       and (p_to   is null or r.redeemed_at <  p_to)
      left join public.orders o on o.id = r.order_id
     group by p.id, p.name, p.code, p.kind, p.usage_limit_total, p.usage_count
     order by count(r.id) desc, p.name;
end;
$fn$;
revoke all on function public.promotion_performance(timestamptz, timestamptz) from public;
grant execute on function public.promotion_performance(timestamptz, timestamptz) to authenticated, service_role;

-- place_order(): same body as before, plus atomic promo-code redemption
-- tracking (usage_count bump + promotion_redemptions insert).
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
  v_line_id uuid; v_recipe_cost int; v_cost_per_base numeric;
  v_promo_id uuid;
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
      -- Atomic, concurrency-safe: the WHERE re-checks available_qty at the
      -- moment of the write, not just at the SELECT above, so two orders
      -- racing for the last unit can't both succeed.
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
           v_variant_name, 0, v_dc.qty * v_qty, 0, '[]'::jsonb)
        returning id into v_line_id;
        if v_variant_id is not null then
          update public.menu_variants set available_qty = available_qty - v_dc.qty * v_qty
           where id = v_variant_id and track_availability and available_qty >= v_dc.qty * v_qty;
          get diagnostics v_upd = row_count;
          if v_track and v_upd = 0 then
            raise exception 'deal_item_unavailable: %', coalesce(v_item_name, '?') using errcode = 'check_violation';
          end if;
        end if;
        -- Recipe explosion, variant-aware exactly like the plain-order path
        -- below (spec §11, §13): a variant-specific recipe fully replaces
        -- the item's base recipe when the component pinned a variant that
        -- has one of its own.
        v_recipe_cost := 0;
        for v_comp in
          select inventory_item_id, qty_per_unit from public.recipe_components
           where menu_item_id = v_item_id
             and variant_id is not distinct from (
               case when exists(
                 select 1 from public.recipe_components where menu_item_id = v_item_id and variant_id = v_variant_id
               ) then v_variant_id else null end)
        loop
          v_need := v_comp.qty_per_unit * v_dc.qty * v_qty;
          select cost_cents_per_base_unit into v_cost_per_base from public.inventory_items where id = v_comp.inventory_item_id;
          v_recipe_cost := v_recipe_cost + round(v_need * coalesce(v_cost_per_base, 0));
          update public.inventory_items set stock_qty = stock_qty - v_need
           where id = v_comp.inventory_item_id and stock_qty >= v_need;
          get diagnostics v_upd = row_count;
          if v_upd = 0 then raise exception 'insufficient_stock: %', v_comp.inventory_item_id using errcode = 'check_violation'; end if;
          insert into public.stock_ledger (inventory_item_id, delta_qty, reason, order_id, unit_cost_cents_base)
          values (v_comp.inventory_item_id, -v_need, 'order_deduction', v_order_id, v_cost_per_base);
        end loop;
        update public.order_lines set recipe_cost_cents = v_recipe_cost where id = v_line_id;
      end loop;

      -- Build-Your-Own selections (spec §7-10): the client sends only
      -- deal_option_items IDs, never a price — re-priced/re-validated here
      -- exactly like item modifiers are, one group at a time (min/max
      -- enforced), before any of it can affect the total. A deal with no
      -- option groups (the plain fixed-price case) simply finds nothing to
      -- loop over here — fully backward compatible.
      declare
        v_deal_opt_ids uuid[] := array(
          select (x)::uuid from jsonb_array_elements_text(coalesce(v_line->'deal_option_ids', '[]'::jsonb)) as x
        );
        v_grp record;
        v_grp_selected int;
        v_oi record;
      begin
        for v_grp in select id, name, min_select, max_select from public.deal_option_groups where deal_id = v_deal_id loop
          select count(*) into v_grp_selected
            from public.deal_option_items doi
           where doi.group_id = v_grp.id and doi.id = any(v_deal_opt_ids);
          if v_grp_selected < v_grp.min_select then
            raise exception 'deal_option_required: %', v_grp.name using errcode = 'check_violation';
          end if;
          if v_grp.max_select is not null and v_grp_selected > v_grp.max_select then
            raise exception 'deal_option_too_many: %', v_grp.name using errcode = 'check_violation';
          end if;
        end loop;

        for v_oi in
          select doi.id, doi.menu_item_id, doi.variant_id, doi.qty, doi.price_adjustment_cents
            from public.deal_option_items doi
            join public.deal_option_groups dog on dog.id = doi.group_id
           where dog.deal_id = v_deal_id and doi.id = any(v_deal_opt_ids)
        loop
          if v_oi.variant_id is not null then
            select v.id, v.menu_item_id, i.name, v.name, v.track_availability, (v.is_available and i.is_available)
              into v_variant_id, v_item_id, v_item_name, v_variant_name, v_track, v_avail
              from public.menu_variants v join public.menu_items i on i.id = v.menu_item_id
             where v.id = v_oi.variant_id;
          else
            v_item_id := v_oi.menu_item_id;
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

          v_lt := v_oi.price_adjustment_cents * v_oi.qty * v_qty;
          v_sub := v_sub + v_lt;
          insert into public.order_lines
            (order_id, deal_id, menu_item_id, variant_id, name_snapshot, variant_name_snapshot,
             unit_price_cents, qty, line_total_cents, modifiers)
          values
            (v_order_id, v_deal_id, v_item_id, v_variant_id,
             v_item_name || case when v_variant_name is not null and v_variant_name <> 'Regular' then ' · ' || v_variant_name else '' end,
             v_variant_name, v_oi.price_adjustment_cents, v_oi.qty * v_qty, v_lt, '[]'::jsonb)
          returning id into v_line_id;

          if v_variant_id is not null then
            update public.menu_variants set available_qty = available_qty - v_oi.qty * v_qty
             where id = v_variant_id and track_availability and available_qty >= v_oi.qty * v_qty;
            get diagnostics v_upd = row_count;
            if v_track and v_upd = 0 then
              raise exception 'deal_item_unavailable: %', coalesce(v_item_name, '?') using errcode = 'check_violation';
            end if;
          end if;

          v_recipe_cost := 0;
          for v_comp in
            select inventory_item_id, qty_per_unit from public.recipe_components
             where menu_item_id = v_item_id
               and variant_id is not distinct from (
                 case when exists(
                   select 1 from public.recipe_components where menu_item_id = v_item_id and variant_id = v_variant_id
                 ) then v_variant_id else null end)
          loop
            v_need := v_comp.qty_per_unit * v_oi.qty * v_qty;
            select cost_cents_per_base_unit into v_cost_per_base from public.inventory_items where id = v_comp.inventory_item_id;
            v_recipe_cost := v_recipe_cost + round(v_need * coalesce(v_cost_per_base, 0));
            update public.inventory_items set stock_qty = stock_qty - v_need
             where id = v_comp.inventory_item_id and stock_qty >= v_need;
            get diagnostics v_upd = row_count;
            if v_upd = 0 then raise exception 'insufficient_stock: %', v_comp.inventory_item_id using errcode = 'check_violation'; end if;
            insert into public.stock_ledger (inventory_item_id, delta_qty, reason, order_id, unit_cost_cents_base)
            values (v_comp.inventory_item_id, -v_need, 'order_deduction', v_order_id, v_cost_per_base);
          end loop;
          update public.order_lines set recipe_cost_cents = v_recipe_cost where id = v_line_id;
        end loop;
      end;

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
      v_valid_mod_ids uuid[];
      v_grp record;
      v_grp_selected int;
      v_has_variant_recipe boolean;
    begin
      select coalesce(sum(mo.price_cents), 0),
             coalesce(jsonb_agg(jsonb_build_object('id', mo.id, 'name', mo.name, 'price_cents', mo.price_cents)
                                 order by mo.sort_order), '[]'::jsonb),
             coalesce(array_agg(mo.id), '{}')
        into v_mod_total, v_mod_snapshot, v_valid_mod_ids
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
         nullif(left(coalesce(v_line->>'note', ''), 500), ''))
      returning id into v_line_id;

      -- Recipe explosion (spec §9-11): a recipe row scoped to THIS variant
      -- fully replaces the item's base recipe when one exists; otherwise the
      -- base recipe (variant_id is null) applies. Never both, never a naive
      -- "same recipe regardless of size" assumption.
      v_recipe_cost := 0;
      select exists(
        select 1 from public.recipe_components where menu_item_id = v_item_id and variant_id = v_variant_id
      ) into v_has_variant_recipe;
      for v_comp in
        select inventory_item_id, qty_per_unit from public.recipe_components
         where menu_item_id = v_item_id
           and variant_id is not distinct from (case when v_has_variant_recipe then v_variant_id else null end)
      loop
        v_need := v_comp.qty_per_unit * v_qty;
        select cost_cents_per_base_unit into v_cost_per_base from public.inventory_items where id = v_comp.inventory_item_id;
        v_recipe_cost := v_recipe_cost + round(v_need * coalesce(v_cost_per_base, 0));
        update public.inventory_items set stock_qty = stock_qty - v_need
         where id = v_comp.inventory_item_id and stock_qty >= v_need;
        get diagnostics v_upd = row_count;
        if v_upd = 0 then raise exception 'insufficient_stock: %', v_comp.inventory_item_id using errcode = 'check_violation'; end if;
        insert into public.stock_ledger (inventory_item_id, delta_qty, reason, order_id, unit_cost_cents_base)
        values (v_comp.inventory_item_id, -v_need, 'order_deduction', v_order_id, v_cost_per_base);
      end loop;

      -- Modifier-linked consumption (spec §12): e.g. Extra Cheese consumes
      -- one more cheese slice, Extra Patty another 150g of chicken — on top
      -- of, not instead of, the base/variant recipe above.
      for v_comp in
        select inventory_item_id, sum(qty_base) as qty_per_unit
          from public.modifier_recipe_components
         where modifier_option_id = any(v_valid_mod_ids)
         group by inventory_item_id
      loop
        v_need := v_comp.qty_per_unit * v_qty;
        select cost_cents_per_base_unit into v_cost_per_base from public.inventory_items where id = v_comp.inventory_item_id;
        v_recipe_cost := v_recipe_cost + round(v_need * coalesce(v_cost_per_base, 0));
        update public.inventory_items set stock_qty = stock_qty - v_need
         where id = v_comp.inventory_item_id and stock_qty >= v_need;
        get diagnostics v_upd = row_count;
        if v_upd = 0 then raise exception 'insufficient_stock: %', v_comp.inventory_item_id using errcode = 'check_violation'; end if;
        insert into public.stock_ledger (inventory_item_id, delta_qty, reason, order_id, unit_cost_cents_base)
        values (v_comp.inventory_item_id, -v_need, 'order_deduction', v_order_id, v_cost_per_base);
      end loop;

      update public.order_lines set recipe_cost_cents = v_recipe_cost where id = v_line_id;
    end;

    -- Variant availability counter — atomic, concurrency-safe (see the deal
    -- branch above for why: re-checks available_qty at write time, not just
    -- at the SELECT above, so two orders racing for the last unit can't both win).
    if v_variant_id is not null then
      update public.menu_variants
         set available_qty = available_qty - v_qty
       where id = v_variant_id and track_availability and available_qty >= v_qty;
      get diagnostics v_upd = row_count;
      if v_track and v_upd = 0 then
        raise exception 'item_unavailable: %', coalesce(v_item_name, v_item_id::text) using errcode = 'check_violation';
      end if;
    end if;
    end if;
  end loop;

  -- A promo code, if supplied and valid, decides the discount (staff-applied
  -- p_discount_cents is the fallback for manual till discounts). Redeeming
  -- it — bumping usage_count and logging promotion_redemptions — happens
  -- HERE, not inside promo_discount() (which stays a read-only validity
  -- check reused by the storefront's live preview), and the usage_count
  -- bump is itself the concurrency guard: two orders racing for the last
  -- redemption of a capped code can't both win, same atomic
  -- update-with-a-still-true-where-clause pattern as deal/variant
  -- availability above.
  if coalesce(p_promo_code, '') <> '' then
    v_disc := public.promo_discount(p_promo_code, v_sub);
    if v_disc > 0 then
      v_promo_id := null;
      update public.promotions set usage_count = usage_count + 1
       where lower(code) = lower(p_promo_code)
         and (usage_limit_total is null or usage_count < usage_limit_total)
      returning id into v_promo_id;
      if v_promo_id is null then
        v_disc := 0; -- lost the race against the usage cap between validation and now
      else
        insert into public.promotion_redemptions (promotion_id, order_id, discount_cents)
        values (v_promo_id, v_order_id, v_disc);
      end if;
    end if;
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
