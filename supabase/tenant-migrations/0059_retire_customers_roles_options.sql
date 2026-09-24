-- ============================================================================
-- Tenant delta 0059 — retire the Customers and Roles & Access portal options.
--
-- The owner removed the Customers, Reservations and Roles & Access sections
-- (and Assign staff) from the product. Reservations had no permission keys
-- of its own (it used tables.*, which still drive Tables & QR codes), so
-- only these catalog rows go — Create Portal no longer offers them.
-- permissions.assign stays: the Staff screen's role change uses it.
--
-- Any portal still holding a retired key has it stripped, so nothing keeps
-- an invisible grant. The customers table and the role presets themselves
-- are left in place (no data is deleted).
-- ============================================================================

delete from public.permission_catalog
 where key in ('customers.view', 'customers.create', 'customers.update',
               'roles.view', 'roles.create', 'roles.update', 'roles.delete',
               'permissions.view');

update public.portals
   set permissions = array(
         select k from unnest(permissions) as k
          where k not in ('customers.view', 'customers.create', 'customers.update',
                          'roles.view', 'roles.create', 'roles.update', 'roles.delete',
                          'permissions.view'))
 where permissions && array['customers.view', 'customers.create', 'customers.update',
                            'roles.view', 'roles.create', 'roles.update', 'roles.delete',
                            'permissions.view'];
