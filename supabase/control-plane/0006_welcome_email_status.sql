-- ============================================================================
-- Control-plane 0006 — welcome-email + provisioning-attempt tracking
--
-- Platform-level provisioning metadata (allowed in the control plane). Lets the
-- retry sweep bound its attempts and the admin UI see / resend the welcome
-- email when delivery failed.
-- ============================================================================

alter table public.tenants
  add column if not exists welcome_email_status  text        not null default 'pending',
  add column if not exists welcome_email_sent_at timestamptz,
  add column if not exists welcome_email_error   text,
  add column if not exists provisioning_attempts int         not null default 0;

-- Business details captured at checkout (metadata only — never operational data).
alter table public.tenants
  add column if not exists owner_name   text,
  add column if not exists phone        text,
  add column if not exists country      text,
  add column if not exists address      text,
  add column if not exists branch_name  text,
  add column if not exists table_count  int;
