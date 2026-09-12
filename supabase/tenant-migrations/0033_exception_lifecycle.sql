-- 0033: Exception lifecycle state. computeAttentionItems() (the Exception
-- Center / AI's "what needs my attention") is deliberately stateless — it
-- recomputes fresh every call. This table lets a manager note "seen this,
-- handling it" without the exact same message reappearing as if untouched.
-- Keyed on the exception's own "category::message" text (it has no row of
-- its own to attach state to) — the moment the underlying condition
-- changes, that's a materially different exception and correctly starts
-- unacknowledged again.

do $$ begin
  if not exists (select 1 from pg_type where typname = 'exception_state_status' and typnamespace = 'app'::regnamespace) then
    create type app.exception_state_status as enum ('acknowledged', 'resolved', 'ignored');
  end if;
end $$;

create table if not exists public.exception_states (
  fingerprint  text primary key,
  status       app.exception_state_status not null,
  note         text,
  actor_id     uuid,
  actor_email  text,
  actor_role   text,
  updated_at   timestamptz not null default now()
);

alter table public.exception_states enable row level security;
drop policy if exists staff_read on public.exception_states;
create policy staff_read on public.exception_states for select using (app.has_perm('orders.view') or app.is_staff());
drop policy if exists mgr_write on public.exception_states;
create policy mgr_write on public.exception_states for all
  using (app.has_perm('orders.view') or app.can_write())
  with check (app.has_perm('orders.view') or app.can_write());
