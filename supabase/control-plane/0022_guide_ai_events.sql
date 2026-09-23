-- Guide AI analytics events table.
-- Logs widget interactions for product analytics without requiring a third-party
-- SDK.  All rows are written server-side (service-role only); no public access.
-- ip_hash is a one-way hash of the remote IP — never store the raw IP.

create table if not exists public.guide_ai_events (
  id               uuid primary key default gen_random_uuid(),
  created_at       timestamptz not null default now(),
  session_id       text not null,                  -- client-generated opaque id per widget session
  tenant_slug      text,                           -- null for public/unauthenticated sessions
  event            text not null,                  -- see VALID_EVENTS below
  metadata         jsonb not null default '{}',    -- event-specific payload (page, prompt, feature, etc.)
  ip_hash          text                            -- sha-256 hex of remote IP (rate-limit / abuse detection)
);

comment on table public.guide_ai_events is
  'Automation Restaurant AI Guide analytics events — widget interactions, diagnostics, conversions.';

-- Valid event enum (enforced by check constraint so queries can trust the values).
alter table public.guide_ai_events
  add constraint guide_ai_events_event_check check (event in (
    'widget_opened',
    'widget_closed',
    'prompt_selected',
    'message_sent',
    'article_shown',
    'issue_diagnosed',
    'guide_completed',
    'feature_recommended',
    'billing_opened',
    'signup_started',
    'trial_started',
    'support_escalated',
    'resolution_marked',
    'secret_warning_shown'
  ));

-- Indexes for the queries the admin panel and analytics reports will run.
create index guide_ai_events_created_at_idx  on public.guide_ai_events (created_at desc);
create index guide_ai_events_tenant_slug_idx on public.guide_ai_events (tenant_slug) where tenant_slug is not null;
create index guide_ai_events_event_idx       on public.guide_ai_events (event);

-- RLS: only the service role (server-side) may read or write.
alter table public.guide_ai_events enable row level security;
-- No policies → only service-role bypasses RLS; anon/authenticated get nothing.
