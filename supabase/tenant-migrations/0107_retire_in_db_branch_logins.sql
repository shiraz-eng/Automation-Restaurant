-- ============================================================================
-- 0107 — Retire the in-database branch logins (0098–0106).
--
-- Branches are now separate restaurants, each with its own project, created
-- from the owner panel (control-plane 0025). The screens that limited a
-- portal or staff login to some branches of this database are gone, so no
-- login may stay limited by a setting nobody can see or change any more:
-- every portal and membership works across the whole restaurant again.
--
-- The branch tables, their rows and the functions stay — nothing is deleted.
-- ============================================================================

update public.portals     set branch_ids = '{}' where cardinality(branch_ids) > 0;
update public.memberships set branch_ids = '{}' where cardinality(branch_ids) > 0;
