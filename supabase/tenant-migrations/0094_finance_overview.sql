-- ============================================================================
-- 0094_finance_overview.sql — Finance Phase G (overview, food cost, aging)
--   food_cost_target_bps   the restaurant's target food cost (default 30%)
--   set_food_cost_target() change it (finance.manage_costs / owner-manager)
--   food_cost_watch()      every menu recipe: price, current cost, food cost
--                          %, the cost N days ago, change in points, and
--                          whether it is over target or rising
--   payables_aging()       outstanding approved supplier invoices by supplier
--                          in current / 1-30 / 31-60 / 61-90 / 90+ days overdue
-- ============================================================================

alter table public.business_settings
  add column if not exists food_cost_target_bps int not null default 3000;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'business_settings_food_cost_target_check') then
    alter table public.business_settings add constraint business_settings_food_cost_target_check
      check (food_cost_target_bps between 100 and 9000);
  end if;
end $$;

create or replace function public.set_food_cost_target(p_pct numeric) returns int
language plpgsql security definer set search_path = public, app as $fn$
declare v_old int; v_new int := round(coalesce(p_pct, 0) * 100);
begin
  if not (app.has_perm('finance.manage_costs') or app.can_write()) then
    raise exception 'forbidden' using errcode = 'insufficient_privilege';
  end if;
  if v_new < 100 or v_new > 9000 then
    raise exception 'bad_target: use a percentage between 1 and 90' using errcode = 'check_violation';
  end if;
  select food_cost_target_bps into v_old from public.business_settings limit 1;
  update public.business_settings set food_cost_target_bps = v_new where id;
  perform app.log_action('finance.food_cost_target', 'business_settings', 'food_cost_target_bps',
    jsonb_build_object('pct', v_old / 100.0), jsonb_build_object('pct', v_new / 100.0));
  return v_new;
end $fn$;
revoke all on function public.set_food_cost_target(numeric) from public;
grant execute on function public.set_food_cost_target(numeric) to authenticated, service_role;

create or replace function public.food_cost_watch(p_days int default 30)
returns table (
  recipe_id uuid, name text, menu_item_id uuid, variant_id uuid,
  price_cents int, cost_cents int, food_cost_pct numeric,
  previous_cost_cents int, previous_food_cost_pct numeric, change_pts numeric,
  target_pct numeric, over_target boolean, rising boolean
)
language plpgsql stable security definer set search_path = public, app as $fn$
declare v_target numeric;
begin
  if not (app.has_perm('finance.view_cogs') or app.has_perm('finance.view_profit') or app.has_perm('inventory.view_cost')
          or app.has_perm('finance.manage_costs')) then
    raise exception 'forbidden' using errcode = 'insufficient_privilege';
  end if;
  select coalesce(food_cost_target_bps, 3000) / 100.0 into v_target from public.business_settings limit 1;
  v_target := coalesce(v_target, 30);
  return query
  with r as (
    select rc.id, rc.name, rc.menu_item_id, rc.variant_id, rc.current_version_id,
           coalesce(
             (select mv.price_cents from public.menu_variants mv where mv.id = rc.variant_id),
             (select mv.price_cents from public.menu_variants mv where mv.menu_item_id = rc.menu_item_id
               order by mv.sort_order, mv.created_at limit 1),
             (select mi.price_cents from public.menu_items mi where mi.id = rc.menu_item_id)
           ) as price,
           public.recipe_version_cost_per_yield_unit(rc.current_version_id) as cost_now,
           coalesce(
             (select l.cost_cents from public.recipe_cost_log l
               where l.recipe_version_id = rc.current_version_id and l.recorded_at <= now() - make_interval(days => greatest(p_days, 1))
               order by l.recorded_at desc limit 1),
             (select l.cost_cents from public.recipe_cost_log l
               where l.recipe_version_id = rc.current_version_id order by l.recorded_at limit 1)
           ) as cost_then
      from public.recipes rc
     where rc.recipe_type in ('menu_item', 'variant') and rc.status = 'active' and rc.current_version_id is not null
  )
  select r.id, r.name, r.menu_item_id, r.variant_id, r.price::int, r.cost_now::int,
         case when r.price > 0 then round(r.cost_now::numeric / r.price * 1000) / 10 end,
         r.cost_then::int,
         case when r.price > 0 and r.cost_then is not null then round(r.cost_then::numeric / r.price * 1000) / 10 end,
         case when r.price > 0 and r.cost_then is not null then round((r.cost_now - r.cost_then)::numeric / r.price * 1000) / 10 end,
         v_target,
         r.price > 0 and r.cost_now::numeric / r.price * 100 > v_target,
         r.cost_then is not null and r.cost_now > r.cost_then
    from r
   order by case when r.price > 0 then r.cost_now::numeric / r.price else 0 end desc;
end $fn$;
revoke all on function public.food_cost_watch(int) from public;
grant execute on function public.food_cost_watch(int) to authenticated, service_role;

create or replace function public.payables_aging()
returns table (
  supplier_id uuid, supplier_name text, invoices int,
  current_cents bigint, d1_30_cents bigint, d31_60_cents bigint, d61_90_cents bigint, d90_plus_cents bigint,
  total_cents bigint
)
language plpgsql stable security definer set search_path = public, app as $fn$
begin
  if not (app.has_perm('payables.view') or app.has_perm('payables.manage') or app.has_perm('finance.view') or app.can_write()) then
    raise exception 'forbidden' using errcode = 'insufficient_privilege';
  end if;
  return query
  with o as (
    select i.supplier_id as sid, app.invoice_outstanding_cents(i.id)::bigint as amt,
           (app.business_day(now()) - coalesce(i.due_date, i.invoice_date)) as late
      from public.supplier_invoices i
     where i.status in ('approved', 'partially_paid')
  )
  select s.id, s.name, count(*)::int,
         coalesce(sum(o.amt) filter (where o.late <= 0), 0)::bigint,
         coalesce(sum(o.amt) filter (where o.late between 1 and 30), 0)::bigint,
         coalesce(sum(o.amt) filter (where o.late between 31 and 60), 0)::bigint,
         coalesce(sum(o.amt) filter (where o.late between 61 and 90), 0)::bigint,
         coalesce(sum(o.amt) filter (where o.late > 90), 0)::bigint,
         coalesce(sum(o.amt), 0)::bigint
    from o join public.suppliers s on s.id = o.sid
   where o.amt > 0
   group by s.id, s.name
   order by sum(o.amt) desc;
end $fn$;
revoke all on function public.payables_aging() from public;
grant execute on function public.payables_aging() to authenticated, service_role;
