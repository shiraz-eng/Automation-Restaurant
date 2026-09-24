-- ============================================================================
-- Tenant delta 0064 — Deals & Combos workspace.
--
-- Extends the existing deals model (deals / deal_components /
-- deal_option_groups / deal_option_items, place_order()'s header +
-- component lines, deal_profitability()) with what the redesigned Deals &
-- Combos screens need. No second deal model.
--
--   * deals gains: type, lifecycle status (draft/active/paused — "scheduled"
--     and "expired" are derived from starts_at/ends_at), a DEAL-00001
--     reference, customer display (tagline, badge, show savings), schedule
--     (days of week + daily time window), rules (min/max per order, total
--     usage limit) and channels (order types + sales channels).
--   * status and the existing is_available flag stay in sync both ways, so
--     every existing reader (storefront, place_order, AI) keeps working.
--   * The new rules are enforced server-side when an order is placed
--     (BEFORE INSERT on the deal's header order line) — never only in UI.
--   * Read-only RPCs for the screens: deal_performance (usage/revenue per
--     deal + daily series), deal_availability (how many of each deal can
--     be made right now, from the authoritative product_availability and
--     the bottleneck item), deal_cost_estimate (food cost of a draft combo),
--     live_deal_ids (deals sellable right now on a given channel).
--   * Deal images can be uploaded by deals.create/deals.update holders
--     into the existing public menu-images bucket, under deals/.
-- ============================================================================

-- ── Columns ───────────────────────────────────────────────────────────────
alter table public.deals add column if not exists deal_type text not null default 'combo';
alter table public.deals add column if not exists status text not null default 'active';
alter table public.deals add column if not exists ref_code text;
alter table public.deals add column if not exists tagline text;
alter table public.deals add column if not exists badge text;
alter table public.deals add column if not exists show_savings boolean not null default true;
alter table public.deals add column if not exists active_days int[];
alter table public.deals add column if not exists start_time time;
alter table public.deals add column if not exists end_time time;
alter table public.deals add column if not exists min_qty int not null default 1;
alter table public.deals add column if not exists max_qty int;
alter table public.deals add column if not exists usage_limit int;
alter table public.deals add column if not exists order_types text[] not null default array['dine_in', 'takeaway', 'delivery'];
alter table public.deals add column if not exists sales_channels text[] not null default array['customer_portal', 'pos'];
alter table public.deals add column if not exists updated_at timestamptz not null default now();

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'deals_deal_type_check') then
    alter table public.deals add constraint deals_deal_type_check
      check (deal_type in ('combo', 'meal_deal', 'bucket', 'discount'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'deals_status_check') then
    alter table public.deals add constraint deals_status_check check (status in ('draft', 'active', 'paused'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'deals_rules_check') then
    alter table public.deals add constraint deals_rules_check check (
      min_qty >= 1 and (max_qty is null or max_qty >= min_qty) and (usage_limit is null or usage_limit >= 1)
      and (active_days is null or active_days <@ array[0, 1, 2, 3, 4, 5, 6])
      and order_types <@ array['dine_in', 'takeaway', 'delivery']
      and sales_channels <@ array['customer_portal', 'pos']);
  end if;
end $$;

create sequence if not exists public.deal_ref_seq;
update public.deals set status = case when is_available then 'active' else 'paused' end
 where ref_code is null;
update public.deals set ref_code = 'DEAL-' || lpad(nextval('public.deal_ref_seq')::text, 5, '0')
 where ref_code is null;
create unique index if not exists deals_ref_code_uq on public.deals(ref_code);

-- status ↔ is_available stay in sync; every new deal gets a reference.
create or replace function app.deals_before_write() returns trigger
language plpgsql as $$
begin
  if new.ref_code is null then
    new.ref_code := 'DEAL-' || lpad(nextval('public.deal_ref_seq')::text, 5, '0');
  end if;
  if tg_op = 'INSERT' then
    -- An older caller that only sets is_available = false means "paused".
    if new.status = 'active' and not new.is_available then
      new.status := 'paused';
    end if;
    new.is_available := new.status = 'active';
  elsif new.status is distinct from old.status then
    new.is_available := new.status = 'active';
  elsif new.is_available is distinct from old.is_available then
    new.status := case when new.is_available then 'active' else 'paused' end;
  end if;
  new.updated_at := now();
  return new;
end $$;
drop trigger if exists deals_before_write on public.deals;
create trigger deals_before_write before insert or update on public.deals
  for each row execute function app.deals_before_write();

-- ── Is a deal sellable right now on this sales channel? ────────────────────
create or replace function app.deal_is_live(p_deal public.deals, p_sales_channel text)
returns boolean language sql stable security definer set search_path = public, app as $$
  with tz as (
    select now() at time zone coalesce((select timezone from public.business_settings where id), 'UTC') as local_now
  )
  select p_deal.status = 'active'
     and (p_deal.starts_at is null or p_deal.starts_at <= now())
     and (p_deal.ends_at is null or p_deal.ends_at >= now())
     and (p_sales_channel is null or p_sales_channel = any(p_deal.sales_channels))
     and (p_deal.active_days is null or cardinality(p_deal.active_days) = 0
          or extract(dow from (select local_now from tz))::int = any(p_deal.active_days))
     and (p_deal.start_time is null or p_deal.end_time is null
          or case when p_deal.start_time <= p_deal.end_time
               then (select local_now from tz)::time between p_deal.start_time and p_deal.end_time
               else (select local_now from tz)::time >= p_deal.start_time
                 or (select local_now from tz)::time <= p_deal.end_time  -- window crosses midnight
             end)
$$;

-- For the storefront / menu API (anon): which deals can be ordered now.
create or replace function public.live_deal_ids(p_sales_channel text default 'customer_portal')
returns uuid[] language sql stable security definer set search_path = public, app as $$
  select coalesce(array_agg(d.id), '{}'::uuid[]) from public.deals d where app.deal_is_live(d, p_sales_channel)
$$;
revoke all on function public.live_deal_ids(text) from public;
grant execute on function public.live_deal_ids(text) to anon, authenticated, service_role;

-- ── Order-time enforcement (the deal's HEADER line: deal_id set, no item) ──
create or replace function app.guard_deal_order_line() returns trigger
language plpgsql security definer set search_path = public, app as $fn$
declare
  v_deal public.deals;
  v_order record;
  v_source text;
  v_in_order int;
  v_used int;
begin
  if new.deal_id is null or new.menu_item_id is not null then
    return new;
  end if;
  -- Row lock serializes two orders racing for the last uses of a limit.
  select * into v_deal from public.deals where id = new.deal_id for update;
  if not found then return new; end if;
  select channel::text as channel, session_id into v_order from public.orders where id = new.order_id;
  v_source := case when v_order.session_id is not null then 'customer_portal' else 'pos' end;

  if not app.deal_is_live(v_deal, v_source) then
    raise exception 'deal_unavailable: % is not available right now', v_deal.name using errcode = 'check_violation';
  end if;
  if v_order.channel is not null and not (v_order.channel = any(v_deal.order_types)) then
    raise exception 'deal_unavailable: % is not offered for %', v_deal.name, replace(v_order.channel, '_', ' ')
      using errcode = 'check_violation';
  end if;

  select coalesce(sum(qty), 0) into v_in_order from public.order_lines
   where order_id = new.order_id and deal_id = new.deal_id and menu_item_id is null;
  if new.qty + v_in_order < v_deal.min_qty then
    raise exception 'deal_rule: order at least % × %', v_deal.min_qty, v_deal.name using errcode = 'check_violation';
  end if;
  if v_deal.max_qty is not null and new.qty + v_in_order > v_deal.max_qty then
    raise exception 'deal_rule: at most % × % per order', v_deal.max_qty, v_deal.name using errcode = 'check_violation';
  end if;
  if v_deal.usage_limit is not null then
    select coalesce(sum(l.qty), 0) into v_used
      from public.order_lines l join public.orders o on o.id = l.order_id
     where l.deal_id = new.deal_id and l.menu_item_id is null and o.status <> 'void';
    if v_used + new.qty > v_deal.usage_limit then
      raise exception 'deal_rule: % has reached its limit of % orders', v_deal.name, v_deal.usage_limit
        using errcode = 'check_violation';
    end if;
  end if;
  return new;
end $fn$;
drop trigger if exists guard_deal_order_line on public.order_lines;
create trigger guard_deal_order_line before insert on public.order_lines
  for each row execute function app.guard_deal_order_line();

-- ── Screens: performance, availability, cost estimate ─────────────────────
create or replace function public.deal_performance(p_from timestamptz, p_to timestamptz)
returns table (deal_id uuid, orders bigint, qty bigint, revenue_cents bigint)
language plpgsql stable security definer set search_path = public, app as $fn$
begin
  if not (app.has_perm('deals.view') or app.is_staff()) then
    raise exception 'forbidden' using errcode = 'insufficient_privilege';
  end if;
  return query
    select l.deal_id, count(distinct l.order_id), coalesce(sum(l.qty), 0)::bigint,
           coalesce(sum(l.line_total_cents), 0)::bigint
      from public.order_lines l join public.orders o on o.id = l.order_id
     where l.deal_id is not null and l.menu_item_id is null and o.status <> 'void'
       and o.created_at >= p_from and o.created_at < p_to
     group by l.deal_id;
end $fn$;
revoke all on function public.deal_performance(timestamptz, timestamptz) from public;
grant execute on function public.deal_performance(timestamptz, timestamptz) to authenticated, service_role;

create or replace function public.deal_performance_daily(p_from timestamptz, p_to timestamptz)
returns table (day date, orders bigint, revenue_cents bigint)
language plpgsql stable security definer set search_path = public, app as $fn$
declare v_tz text := coalesce((select timezone from public.business_settings where id), 'UTC');
begin
  if not (app.has_perm('deals.view') or app.is_staff()) then
    raise exception 'forbidden' using errcode = 'insufficient_privilege';
  end if;
  return query
    select g.d::date,
           coalesce(count(distinct l.order_id) filter (where l.order_id is not null), 0)::bigint,
           coalesce(sum(l.line_total_cents), 0)::bigint
      from generate_series((p_from at time zone v_tz)::date, (p_to at time zone v_tz)::date, interval '1 day') g(d)
      left join public.orders o
        on (o.created_at at time zone v_tz)::date = g.d::date and o.status <> 'void'
      left join public.order_lines l
        on l.order_id = o.id and l.deal_id is not null and l.menu_item_id is null
     group by g.d
     order by g.d;
end $fn$;
revoke all on function public.deal_performance_daily(timestamptz, timestamptz) from public;
grant execute on function public.deal_performance_daily(timestamptz, timestamptz) to authenticated, service_role;

-- How many of each deal the kitchen can make now: the minimum over its fixed
-- components of floor(component availability / qty per deal), from the
-- same product_availability rows every other surface reads (a variant
-- without its own recipe uses the item's base row; an untracked component
-- doesn't limit). The legacy manual counter also caps it when enabled.
create or replace function public.deal_availability()
returns table (deal_id uuid, available_qty numeric, bottleneck_name text)
language plpgsql stable security definer set search_path = public, app as $fn$
begin
  if not (app.has_perm('deals.view') or app.has_perm('availability.view') or app.is_staff()) then
    raise exception 'forbidden' using errcode = 'insufficient_privilege';
  end if;
  return query
    with comp as (
      select dc.deal_id, dc.qty, mi.name || coalesce(' · ' || v.name, '') as label,
             coalesce(
               (select pa.producible_qty from public.product_availability pa
                 where pa.menu_item_id = dc.menu_item_id and pa.variant_id = dc.variant_id),
               (select pa.producible_qty from public.product_availability pa
                 where pa.menu_item_id = dc.menu_item_id and pa.variant_id is null)) as producible,
             coalesce(
               (select pa.status from public.product_availability pa
                 where pa.menu_item_id = dc.menu_item_id and pa.variant_id = dc.variant_id),
               (select pa.status from public.product_availability pa
                 where pa.menu_item_id = dc.menu_item_id and pa.variant_id is null)) as status
        from public.deal_components dc
        join public.menu_items mi on mi.id = dc.menu_item_id
        left join public.menu_variants v on v.id = dc.variant_id
    ),
    per as (
      select c.deal_id, c.label,
             case when c.status = 'unavailable' then 0
                  when c.producible is null then null
                  else floor(c.producible / c.qty) end as can_make
        from comp c
    ),
    ranked as (
      select p.*, row_number() over (partition by p.deal_id order by p.can_make asc nulls last) as rn
        from per p
    )
    select d.id,
           case
             when r.can_make is null and not d.track_availability then null
             when r.can_make is null then d.available_qty::numeric
             when d.track_availability then least(r.can_make, d.available_qty)
             else r.can_make
           end,
           case when r.can_make is not null then r.label end
      from public.deals d
      left join ranked r on r.deal_id = d.id and r.rn = 1;
end $fn$;
revoke all on function public.deal_availability() from public;
grant execute on function public.deal_availability() to authenticated, service_role;

-- Food cost of a (possibly unsaved) combo: [{menu_item_id, variant_id, qty}].
-- Same recipe resolution as place_order() (variant recipe replaces the
-- base one). Cost visibility keys only, like deal_profitability().
create or replace function public.deal_cost_estimate(p_components jsonb)
returns table (cost_cents int, cost_known boolean)
language plpgsql stable security definer set search_path = public, app as $fn$
declare v_e jsonb; v_item uuid; v_var uuid; v_qty int; v_has_var boolean;
        v_line numeric; v_total numeric := 0; v_known boolean := true; v_any boolean;
begin
  if not (app.has_perm('inventory.view_cost') or app.has_perm('finance.view_cogs') or app.has_perm('finance.view_profit')) then
    raise exception 'forbidden' using errcode = 'insufficient_privilege';
  end if;
  for v_e in select value from jsonb_array_elements(coalesce(p_components, '[]'::jsonb)) loop
    v_item := nullif(v_e->>'menu_item_id', '')::uuid;
    v_var := nullif(v_e->>'variant_id', '')::uuid;
    v_qty := greatest(coalesce((v_e->>'qty')::int, 1), 1);
    continue when v_item is null;
    select exists(select 1 from public.recipe_components where menu_item_id = v_item and variant_id = v_var)
      into v_has_var;
    select sum(rc.qty_per_unit * coalesce(i.cost_cents_per_base_unit, 0)), count(*) > 0
      into v_line, v_any
      from public.recipe_components rc join public.inventory_items i on i.id = rc.inventory_item_id
     where rc.menu_item_id = v_item
       and rc.variant_id is not distinct from (case when v_has_var then v_var else null end);
    if not coalesce(v_any, false) then v_known := false; end if;
    v_total := v_total + coalesce(v_line, 0) * v_qty;
  end loop;
  return query select round(v_total)::int, v_known;
end $fn$;
revoke all on function public.deal_cost_estimate(jsonb) from public;
grant execute on function public.deal_cost_estimate(jsonb) to authenticated, service_role;

-- ── Deal images ───────────────────────────────────────────────────────────
drop policy if exists "menu-images deal write" on storage.objects;
create policy "menu-images deal write" on storage.objects for all
  using (bucket_id = 'menu-images' and name like 'deals/%'
         and (app.has_perm('deals.create') or app.has_perm('deals.update')))
  with check (bucket_id = 'menu-images' and name like 'deals/%'
              and (app.has_perm('deals.create') or app.has_perm('deals.update')));

-- deals.create holders can fill in the deal they just created (insert only —
-- changing or removing contents later still needs deals.update).
drop policy if exists deals_create_components on public.deal_components;
create policy deals_create_components on public.deal_components for insert with check (app.has_perm('deals.create'));
drop policy if exists deals_create_groups on public.deal_option_groups;
create policy deals_create_groups on public.deal_option_groups for insert with check (app.has_perm('deals.create'));
drop policy if exists deals_create_group_items on public.deal_option_items;
create policy deals_create_group_items on public.deal_option_items for insert with check (app.has_perm('deals.create'));
