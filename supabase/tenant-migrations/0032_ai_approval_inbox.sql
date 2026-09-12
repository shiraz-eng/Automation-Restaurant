-- 0032: AI Approval Inbox. Persists every AI-proposed action (not just the
-- one confirmed inline in the proposing chat) so any authorized approver
-- can see and act on it centrally, matching whichever chat is currently
-- open or not. Writes go through the tenant admin client (same as every
-- other AI route) — RLS here is a defense-in-depth backstop, not the
-- primary gate; the real permission checks live in Express.

do $$ begin
  if not exists (select 1 from pg_type where typname = 'ai_pending_action_status' and typnamespace = 'app'::regnamespace) then
    create type app.ai_pending_action_status as enum ('pending', 'approved', 'rejected', 'expired', 'failed');
  end if;
end $$;

create table if not exists public.ai_pending_actions (
  id                 uuid primary key default gen_random_uuid(),
  action_name        text not null,
  args               jsonb not null,
  summary            text not null,
  status             app.ai_pending_action_status not null default 'pending',
  proposed_by        uuid,
  proposed_by_email  text,
  proposed_by_role   text,
  created_at         timestamptz not null default now(),
  resolved_at        timestamptz,
  resolved_by        uuid,
  resolved_by_email  text,
  result             jsonb,
  error              text
);
create index if not exists ai_pending_actions_status_idx on public.ai_pending_actions(status, created_at desc);

alter table public.ai_pending_actions enable row level security;
drop policy if exists staff_read on public.ai_pending_actions;
create policy staff_read on public.ai_pending_actions for select
  using (app.has_perm('ai.execute_write') or app.has_perm('ai.approve_sensitive_action') or app.can_write());
drop policy if exists mgr_write on public.ai_pending_actions;
create policy mgr_write on public.ai_pending_actions for all
  using (app.has_perm('ai.execute_write') or app.has_perm('ai.approve_sensitive_action') or app.can_write())
  with check (app.has_perm('ai.execute_write') or app.has_perm('ai.approve_sensitive_action') or app.can_write());
