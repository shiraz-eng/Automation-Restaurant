-- ============================================================================
-- 0018_webhook_events_enrichment.sql  (control-plane project)
-- Additive columns on webhook_events so the Overview dashboard's billing-
-- alerts feed can read real backend data — the existing idempotency claim
-- mechanism (upsert id with ignoreDuplicates, in webhooks/stripe.ts) is
-- completely untouched by this migration.
-- ============================================================================

alter table public.webhook_events
  add column if not exists tenant_id  uuid references public.tenants(id) on delete set null,
  add column if not exists summary    text,
  add column if not exists handled_at timestamptz;

alter table public.webhook_events enable row level security;

do $$ begin
  create policy platform_read on public.webhook_events for select
    using (app.has_platform_perm('dashboard.view') or app.has_platform_perm('audit.view'));
exception when duplicate_object then null;
end $$;
