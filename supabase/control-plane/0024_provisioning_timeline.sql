-- ============================================================================
-- Control-plane 0024 — provisioning timeline
--
-- When each setup milestone happened for a new restaurant (step started,
-- project created, database ready, schema applied, owner created, workspace
-- ready, welcome email sent), as ISO timestamps. Lets the time from the
-- owner's Supabase approval to the welcome email be measured per sign-up.
-- ============================================================================

alter table public.tenants add column if not exists provisioning_timeline jsonb;
