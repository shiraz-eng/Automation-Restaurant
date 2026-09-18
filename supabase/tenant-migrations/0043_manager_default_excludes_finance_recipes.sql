-- 0043: Narrows the LIVE 'manager' role's default permissions to match
-- the new schema.sql baseline — removes finance/refund-approval and
-- Recipes & Food Cost cost-visibility keys, which are now opt-in per
-- manager via Roles & Access Control (see 0042's own note on why this
-- restriction is only now meaningful: those RLS policies no longer have
-- a can_write() fallback for manager to fall back on).
--
-- Subtractive, not a blind overwrite: removes exactly these keys from
-- whatever the role's CURRENT array is, so any other customization an
-- Owner already made to the 'manager' role (via Roles & Access Control)
-- is preserved untouched. Idempotent — removing an already-absent key
-- from an array is a no-op.

update public.roles
set permissions = (
  select coalesce(array_agg(k), '{}'::text[])
  from unnest(permissions) as k
  where k not in (
    'payments.refund', 'payments.approve_refund', 'payments.adjust', 'payments.reconcile',
    'finance.view', 'inventory.manage_recipes', 'inventory.view_cost', 'portals.view'
  )
)
where key = 'manager';
