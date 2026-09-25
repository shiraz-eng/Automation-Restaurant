-- 0071: deleting a size (or dish) that has its own recipe failed.
--
-- The size's recipe_components rows are removed by cascade, their trigger
-- recalculates availability for that size, and the recalculation tried to
-- write a product_availability row for a size that no longer exists
-- (foreign-key error), which aborted the delete. A product that is gone now
-- just has its availability row cleared.

create or replace function app.recalc_product_availability(
  p_menu_item_id uuid,
  p_variant_id uuid,
  p_trigger_type text default 'manual_recalculation',
  p_trigger_reference text default null,
  p_actor text default 'system'
) returns void
language plpgsql security definer set search_path = public, app as $$
declare v_r record;
begin
  if not exists (select 1 from public.menu_items where id = p_menu_item_id)
     or (p_variant_id is not null and not exists (select 1 from public.menu_variants where id = p_variant_id)) then
    delete from public.product_availability
     where menu_item_id = p_menu_item_id and variant_id is not distinct from p_variant_id;
    return;
  end if;
  select * into v_r from app.compute_product_capacity(p_menu_item_id, p_variant_id, false);
  perform app.apply_product_availability_result(
    p_menu_item_id, p_variant_id, v_r.tracked, v_r.status, v_r.producible_qty,
    v_r.bottleneck_inventory_item_id, v_r.reason, p_trigger_type, p_trigger_reference, p_actor
  );
end;
$$;
