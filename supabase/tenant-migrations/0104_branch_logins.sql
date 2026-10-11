-- ============================================================================
-- 0104 — Multi-branch: branch panel logins, set up by the owner.
--
-- The owner's panel sees every branch. Each branch gets its own logins (a
-- membership limited to that branch, created from the owner's Branches page):
-- they sign in at the same login page and get the same panel, showing only
-- their branch. This migration:
--   1. lets only head office (a login with no branch limit) create, edit or
--      deactivate branches — a branch login never manages branches;
--   2. adds the Branch manager role: Manager without the keys that change what
--      every branch shares (the menu, sizes, deals, suppliers, sold-out toggles);
--   3. a selected branch the login can't use is ignored (it sees its own), never "nothing";
--   4. my_branch_limited(): whether the signed-in login is limited to branches.
-- ============================================================================

-- 1. Branch management is head office only.
do $mig$
declare f text; def text;
begin
  foreach f in array array[
    'public.create_branch(text,text,text,text,text,text,text,text,jsonb)',
    'public.update_branch(uuid,text,text,text,text,text,text,text,jsonb,jsonb)',
    'public.set_branch_status(uuid,text,text)'
  ] loop
    def := pg_get_functiondef(f::regprocedure);
    if position('app.allowed_branch_ids() is not null or not app.has_perm(''branches.manage'')' in def) > 0 then continue; end if;
    if position('if not app.has_perm(''branches.manage'')' in def) = 0 then
      raise exception '0104: unexpected shape of %', f;
    end if;
    execute replace(def, 'if not app.has_perm(''branches.manage'')',
                         'if app.allowed_branch_ids() is not null or not app.has_perm(''branches.manage'')');
  end loop;
end $mig$;

-- 2. The Branch manager role (memberships.role is an enum; the new value is used by later requests).
alter type app.member_role add value if not exists 'branch_manager';

insert into public.roles (key, name, permissions, is_system)
select 'branch_manager', 'Branch manager',
       array(select p from unnest(r.permissions) p
              where p not in ('menu.create', 'menu.update', 'menu.archive',
                              'variants.create', 'variants.update', 'variants.archive',
                              'deals.create', 'deals.update', 'deals.archive',
                              'supplier.create', 'supplier.update', 'supplier.manage',
                              'availability.update', 'branches.manage', 'permissions.assign')
                and p not like 'staff.%' and p not like 'roles.%' and p not like 'portals.%' and p not like 'settings.%'
              order by p),
       true
  from public.roles r where r.key = 'manager'
on conflict (key) do nothing;

-- 3. The selected branches only ever narrow a login to its own: a selection naming none of
--    them (e.g. a branch cookie left in a browser shared with the owner) means "all of mine",
--    not "nothing".
create or replace function app.selected_branch_ids() returns uuid[]
language plpgsql stable set search_path = public, app as $fn$
declare
  raw text := nullif(trim(coalesce(nullif(current_setting('request.headers', true), '')::json ->> 'x-branch-ids', '')), '');
  v uuid[];
  v_allowed uuid[];
begin
  if raw is null then return null; end if;
  select array_agg(x::uuid) into v
    from unnest(string_to_array(raw, ',')) x
   where trim(x) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
  if v is null then return null; end if;
  v_allowed := app.allowed_branch_ids();
  if v_allowed is not null then
    v := array(select x from unnest(v) x where x = any(v_allowed));
    if cardinality(v) = 0 then return null; end if;
  end if;
  return v;
end $fn$;

-- 4. Is the signed-in login limited to some branches?
create or replace function public.my_branch_limited() returns boolean
language sql stable security definer set search_path = public, app as $fn$
  select app.allowed_branch_ids() is not null
$fn$;
revoke all on function public.my_branch_limited() from public;
grant execute on function public.my_branch_limited() to authenticated, service_role;
