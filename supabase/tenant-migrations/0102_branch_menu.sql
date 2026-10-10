-- ============================================================================
-- 0102 — Multi-branch, phase 5: one menu, branch prices and availability.
--
-- Menu items, sizes, recipes and deals stay shared (no duplicated records).
-- A branch may override a dish — or one size of it — with its own price,
-- and may take it off its menu. place_order() charges the branch price and
-- refuses a dish the branch has switched off; the guest menu and checkout
-- show the same. Overrides are audited and need menu.update / branches.manage.
-- ============================================================================

create table if not exists public.branch_menu_overrides (
  id           uuid primary key default gen_random_uuid(),
  branch_id    uuid not null references public.branches(id) on delete cascade,
  menu_item_id uuid not null references public.menu_items(id) on delete cascade,
  variant_id   uuid references public.menu_variants(id) on delete cascade,
  price_cents  int check (price_cents is null or price_cents >= 0),
  is_available boolean,
  updated_at   timestamptz not null default now(),
  updated_by   uuid
);
create unique index if not exists branch_menu_overrides_key
  on public.branch_menu_overrides (branch_id, menu_item_id, variant_id) nulls not distinct;

alter table public.branch_menu_overrides enable row level security;
drop policy if exists read_all on public.branch_menu_overrides;
-- Prices and availability are public on the menu anyway; staff see their branches'.
create policy read_all on public.branch_menu_overrides for select
  using (app.jwt_role() = 'anon' or app.branch_access(branch_id));

do $$ begin
  if exists (select 1 from pg_proc where proname = 'audit_row' and pronamespace = 'app'::regnamespace) then
    drop trigger if exists audit on public.branch_menu_overrides;
    create trigger audit after insert or update or delete on public.branch_menu_overrides for each row execute function app.audit_row();
  end if;
end $$;

-- Set (or clear, with both null) a branch's override for a dish or one of its sizes.
create or replace function public.set_branch_menu_override(
  p_branch_id uuid, p_menu_item_id uuid, p_variant_id uuid, p_price_cents int, p_is_available boolean
) returns void
language plpgsql security definer set search_path = public, app as $fn$
begin
  if not ((app.has_perm('menu.update') or app.has_perm('branches.manage') or app.can_write()) and app.branch_access(p_branch_id)) then
    raise exception 'forbidden' using errcode = 'insufficient_privilege';
  end if;
  if p_variant_id is not null and not exists (select 1 from public.menu_variants where id = p_variant_id and menu_item_id = p_menu_item_id) then
    raise exception 'variant_not_of_item' using errcode = 'check_violation';
  end if;
  if p_price_cents is null and p_is_available is null then
    delete from public.branch_menu_overrides
     where branch_id = p_branch_id and menu_item_id = p_menu_item_id and variant_id is not distinct from p_variant_id;
    return;
  end if;
  insert into public.branch_menu_overrides (branch_id, menu_item_id, variant_id, price_cents, is_available, updated_by)
  values (p_branch_id, p_menu_item_id, p_variant_id, p_price_cents, p_is_available, app.jwt_sub())
  on conflict (branch_id, menu_item_id, variant_id) do update
    set price_cents = excluded.price_cents, is_available = excluded.is_available, updated_at = now(), updated_by = excluded.updated_by;
end $fn$;
revoke all on function public.set_branch_menu_override(uuid, uuid, uuid, int, boolean) from public;
grant execute on function public.set_branch_menu_override(uuid, uuid, uuid, int, boolean) to authenticated, service_role;

-- place_order: the branch's price and availability for a dish line.
do $mig$
declare
  def text := pg_get_functiondef('public.place_order(text,text,text,integer,jsonb,integer,text,text)'::regprocedure);
  anchor constant text := '       order by v.sort_order, v.created_at limit 1;
    end if;

    if not coalesce(v_avail, false) then
      raise exception ''item_unavailable: %'', coalesce(v_item_name, v_item_id::text)';
  addition constant text := '       order by v.sort_order, v.created_at limit 1;
    end if;

    -- Branch price / availability (0102): the order''s branch may price a dish (or a size) itself
    -- or have switched it off. A size override wins over one for the whole dish.
    select coalesce(o.price_cents, v_price), coalesce(v_avail, false) and coalesce(o.is_available, true)
      into v_price, v_avail
      from (select 1) x
      left join lateral (
        select bo.price_cents, bo.is_available from public.branch_menu_overrides bo
         where bo.branch_id = app.stock_branch_id() and bo.menu_item_id = v_item_id
           and (bo.variant_id = v_variant_id or bo.variant_id is null)
         order by bo.variant_id nulls last limit 1) o on true;

    if not coalesce(v_avail, false) then
      raise exception ''item_unavailable: %'', coalesce(v_item_name, v_item_id::text)';
begin
  if position('branch_menu_overrides' in def) > 0 then return; end if;
  if position(anchor in def) = 0 then raise exception '0102: unexpected shape of place_order()'; end if;
  execute replace(def, anchor, addition);
end $mig$;
