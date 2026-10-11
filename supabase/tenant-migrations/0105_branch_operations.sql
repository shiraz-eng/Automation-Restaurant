-- ============================================================================
-- 0105 — Multi-branch: every branch runs its own operations.
--
-- A branch login (limited to its branch, 0104) works the whole panel for its
-- branch and never sees another branch's data:
--   1. Suppliers belong to a branch or are shared. The owner's suppliers stay
--      shared (branch_id null); a supplier a branch login adds is that branch's
--      own. Its price list, messages, payments and credit notes follow it, so
--      DHA's suppliers and what DHA pays them are invisible to Clifton. A branch
--      reads shared suppliers but only the owner changes them. Supplier
--      payments/credit notes to shared suppliers are made by head office and
--      stay with the owner.
--   2. The Branch manager role gets every feature, except what belongs to the
--      owner: portals, branches, billing, staff and roles, settings, the shared
--      menu, sizes, deals and recipes, sold-out toggles on the shared menu,
--      ledger corrections, adding ingredients to the shared list, and social.
-- ============================================================================

-- 1. Suppliers per branch ------------------------------------------------------
alter table public.suppliers add column if not exists branch_id uuid references public.branches(id);
create index if not exists suppliers_branch_idx on public.suppliers (branch_id);

-- May the caller change a supplier of this branch (null = shared)? Shared: head office only.
create or replace function app.supplier_write_ok(p_branch uuid) returns boolean
language sql stable security definer set search_path = public, app as $fn$
  select case when p_branch is null then app.allowed_branch_ids() is null else app.branch_access(p_branch) end
$fn$;
grant execute on function app.supplier_write_ok(uuid) to authenticated, anon, service_role;

-- A branch login's new supplier is its branch's own; only head office moves a supplier.
create or replace function app.fill_supplier_branch() returns trigger
language plpgsql security definer set search_path = public, app as $fn$
begin
  if tg_op = 'INSERT' then
    if new.branch_id is null and app.allowed_branch_ids() is not null then
      new.branch_id := app.request_branch_id();
    end if;
  elsif new.branch_id is distinct from old.branch_id and app.allowed_branch_ids() is not null then
    raise exception 'forbidden: only the owner moves a supplier between branches' using errcode = 'insufficient_privilege';
  end if;
  return new;
end $fn$;
drop trigger if exists fill_supplier_branch on public.suppliers;
create trigger fill_supplier_branch before insert or update of branch_id on public.suppliers
  for each row execute function app.fill_supplier_branch();

drop policy if exists branch_wall_read on public.suppliers;
drop policy if exists branch_wall_insert on public.suppliers;
drop policy if exists branch_wall_update on public.suppliers;
drop policy if exists branch_wall_delete on public.suppliers;
create policy branch_wall_read on public.suppliers as restrictive for select
  using (branch_id is null or app.in_scope(branch_id));
create policy branch_wall_insert on public.suppliers as restrictive for insert
  with check (app.supplier_write_ok(branch_id));
create policy branch_wall_update on public.suppliers as restrictive for update
  using (app.supplier_write_ok(branch_id)) with check (app.supplier_write_ok(branch_id));
create policy branch_wall_delete on public.suppliers as restrictive for delete
  using (app.supplier_write_ok(branch_id));

-- Price lists and messages follow their supplier: visible when it is, changed only when it may be.
do $mig$
declare t text;
begin
  foreach t in array array['supplier_items', 'supplier_communications'] loop
    if to_regclass('public.' || t) is null then continue; end if;
    execute format('drop policy if exists branch_wall_read on public.%I', t);
    execute format('drop policy if exists branch_wall_write on public.%I', t);
    execute format('drop policy if exists branch_wall_insert on public.%I', t);
    execute format('drop policy if exists branch_wall_update on public.%I', t);
    execute format('drop policy if exists branch_wall_delete on public.%I', t);
    execute format($p$create policy branch_wall_read on public.%I as restrictive for select
      using (exists (select 1 from public.suppliers s where s.id = supplier_id))$p$, t);
    execute format($p$create policy branch_wall_insert on public.%I as restrictive for insert
      with check (exists (select 1 from public.suppliers s where s.id = supplier_id and app.supplier_write_ok(s.branch_id)))$p$, t);
    execute format($p$create policy branch_wall_update on public.%I as restrictive for update
      using (exists (select 1 from public.suppliers s where s.id = supplier_id and app.supplier_write_ok(s.branch_id)))
      with check (exists (select 1 from public.suppliers s where s.id = supplier_id and app.supplier_write_ok(s.branch_id)))$p$, t);
    execute format($p$create policy branch_wall_delete on public.%I as restrictive for delete
      using (exists (select 1 from public.suppliers s where s.id = supplier_id and app.supplier_write_ok(s.branch_id)))$p$, t);
  end loop;
end $mig$;

-- Supplier payments and credit notes: head office sees all; a branch login only those to its own suppliers.
do $mig$
declare t text;
begin
  foreach t in array array['supplier_payments', 'supplier_credit_notes'] loop
    if to_regclass('public.' || t) is null then continue; end if;
    execute format('drop policy if exists branch_wall_read on public.%I', t);
    execute format($p$create policy branch_wall_read on public.%I as restrictive for select
      using (app.allowed_branch_ids() is null
             or exists (select 1 from public.suppliers s where s.id = supplier_id and s.branch_id is not null))$p$, t);
  end loop;
end $mig$;

-- 2. The Branch manager role: the whole panel for its branch ----------------------
update public.roles
   set permissions = array(
     select c.key from public.permission_catalog c
      where c.key not like 'portals.%' and c.key not like 'branches.%' and c.key not like 'social.%'
        and c.key not in (
          'permissions.assign', 'settings.update',
          'staff.create', 'staff.update', 'staff.delete',
          'menu.create', 'menu.update', 'menu.delete',
          'variants.create', 'variants.update', 'variants.archive',
          'deals.create', 'deals.update', 'deals.archive',
          'availability.update', 'inventory.manage', 'inventory.manage_recipes', 'finance.manage_recipes',
          'finance.adjust_ledger')
      order by c.key)
 where key = 'branch_manager';

-- Branch managers who already have a login pick the new permissions up on their next sign-in.
do $mig$
declare v_perms text[];
begin
  select permissions into v_perms from public.roles where key = 'branch_manager';
  update auth.users u
     set raw_app_meta_data = coalesce(u.raw_app_meta_data, '{}'::jsonb) || jsonb_build_object('permissions', to_jsonb(v_perms))
    from public.memberships m
   where m.user_id = u.id and m.role::text = 'branch_manager' and coalesce(cardinality(m.extra_permissions), 0) = 0;
end $mig$;
