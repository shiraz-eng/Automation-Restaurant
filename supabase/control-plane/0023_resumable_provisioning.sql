-- ============================================================================
-- Control-plane 0023 — resumable provisioning on serverless
--
-- The API runs on Vercel functions (60 s limit, frozen after the response),
-- but creating a Supabase project takes 1-3 minutes. Provisioning now runs
-- in short resumable steps, advanced by the onboarding screen's status polls
-- (and the cron sweep), instead of one long background task that got cut off.
--
-- * tenants.provisioning_heartbeat — a short lease: only one step runs per
--   restaurant at a time; a stale lease (the function was frozen/killed) is
--   taken over by the next poll.
-- * tenant_projects.anon_key nullable — the project is registered the moment
--   Supabase accepts it (before its keys exist), so a step cut off right
--   after creation resumes on that same project instead of creating another.
--   tenant_directory only lists ACTIVE restaurants, so a half-built row is
--   never visible to the web app.
-- ============================================================================

alter table public.tenants add column if not exists provisioning_heartbeat timestamptz;
alter table public.tenant_projects alter column anon_key drop not null;
