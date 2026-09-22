-- ============================================================================
-- 0014_platform_audit.sql  (control-plane project)
-- Platform-level audit log — mirrors the tenant audit_logs + app.audit_row()
-- trigger pattern (supabase/tenant-template/schema.sql) exactly, minus the
-- tenant-only portal_id column. A blanket trigger captures raw table DML;
-- app.log_admin_action() lets specific RPCs additionally record a
-- human-readable domain event (mirrors app.log_action() on the tenant side).
-- ============================================================================

create table public.audit_logs (
  id          bigint generated always as identity primary key,
  actor_id    uuid,
  actor_email text,
  actor_role  text,
  action      text not null,   -- INSERT | UPDATE | DELETE | domain verb, e.g. 'subscription.canceled'
  entity      text not null,   -- table name
  entity_id   text,
  before      jsonb,
  after       jsonb,
  created_at  timestamptz not null default now()
);
create index audit_logs_created_idx on public.audit_logs(created_at desc);
create index audit_logs_entity_idx on public.audit_logs(entity, created_at desc);

alter table public.audit_logs enable row level security;
create policy platform_admin_read on public.audit_logs for select
  using (app.has_platform_perm('audit.view'));

create or replace function app.audit_row() returns trigger
language plpgsql security definer set search_path = public, app as $fn$
declare
  v_claims jsonb := nullif(current_setting('request.jwt.claims', true), '')::jsonb;
begin
  insert into public.audit_logs (actor_id, actor_email, actor_role, action, entity, entity_id, before, after)
  values (
    (v_claims #>> '{sub}')::uuid,
    v_claims #>> '{email}',
    v_claims #>> '{app_metadata,role}',
    tg_op,
    tg_table_name,
    coalesce(to_jsonb(new) ->> 'id', to_jsonb(old) ->> 'id'),
    case when tg_op in ('UPDATE', 'DELETE') then to_jsonb(old) end,
    case when tg_op in ('UPDATE', 'INSERT') then to_jsonb(new) end
  );
  return coalesce(new, old);
end
$fn$;

create or replace function app.log_admin_action(
  p_action text, p_entity text, p_entity_id text,
  p_before jsonb default null, p_after jsonb default null
) returns void
language plpgsql security definer set search_path = public, app as $fn$
declare
  v_claims jsonb := nullif(current_setting('request.jwt.claims', true), '')::jsonb;
begin
  insert into public.audit_logs (actor_id, actor_email, actor_role, action, entity, entity_id, before, after)
  values (
    app.jwt_sub(),
    v_claims #>> '{email}',
    v_claims #>> '{app_metadata,role}',
    p_action, p_entity, p_entity_id, p_before, p_after
  );
end
$fn$;

do $$
begin
  create trigger audit after insert or update or delete on public.tenants
    for each row execute function app.audit_row();
exception when duplicate_object then null;
end $$;

do $$
begin
  create trigger audit after insert or update or delete on public.subscriptions
    for each row execute function app.audit_row();
exception when duplicate_object then null;
end $$;

do $$
begin
  create trigger audit after insert or update or delete on public.plans
    for each row execute function app.audit_row();
exception when duplicate_object then null;
end $$;

do $$
begin
  create trigger audit after insert or update or delete on public.site_sections
    for each row execute function app.audit_row();
exception when duplicate_object then null;
end $$;

do $$
begin
  create trigger audit after insert or update or delete on public.platform_admins
    for each row execute function app.audit_row();
exception when duplicate_object then null;
end $$;

do $$
begin
  create trigger audit after insert or update or delete on public.platform_roles
    for each row execute function app.audit_row();
exception when duplicate_object then null;
end $$;
