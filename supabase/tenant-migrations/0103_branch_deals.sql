-- ============================================================================
-- 0103 — Multi-branch: deals follow the branch menu.
--
-- A deal stays shared, at its own deal price. But a dish (or size) a branch
-- has switched off (branch_menu_overrides.is_available = false, 0102) cannot
-- be sold there inside a deal either: the deal's component lines are checked
-- against the order's branch when they are written. The guest menu hides
-- such deals and choices with the same rule.
-- ============================================================================

create or replace function app.guard_branch_deal_line() returns trigger
language plpgsql security definer set search_path = public, app as $fn$
declare v_branch uuid; v_off boolean;
begin
  if new.deal_id is null or new.menu_item_id is null then return new; end if;
  select o.branch_id into v_branch from public.orders o where o.id = new.order_id;
  if v_branch is null then return new; end if;
  -- A size override wins over one for the whole dish, as in place_order (0102).
  select bo.is_available = false into v_off
    from public.branch_menu_overrides bo
   where bo.branch_id = v_branch and bo.menu_item_id = new.menu_item_id
     and (bo.variant_id = new.variant_id or bo.variant_id is null)
   order by bo.variant_id nulls last limit 1;
  if coalesce(v_off, false) then
    raise exception 'deal_item_unavailable: %', coalesce(new.name_snapshot, '?') using errcode = 'check_violation';
  end if;
  return new;
end $fn$;

drop trigger if exists guard_branch_deal_line on public.order_lines;
create trigger guard_branch_deal_line before insert on public.order_lines
  for each row execute function app.guard_branch_deal_line();
