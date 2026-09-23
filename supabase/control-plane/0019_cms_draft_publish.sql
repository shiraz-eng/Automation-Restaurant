-- ============================================================================
-- 0019_cms_draft_publish.sql  (control-plane project)
-- Real draft/publish separation for site_sections: editing now writes to
-- draft_content, never live content, until an explicit Publish. Every
-- publish/unpublish/draft-save is snapshotted into site_section_revisions.
-- Public read path (content, is_active, anon_read_active, getSectionContent())
-- is completely untouched — publishing just means the admin write path now
-- flows draft_content -> content before it's visible.
-- ============================================================================

alter table public.site_sections
  add column if not exists draft_content    jsonb,
  add column if not exists seo              jsonb not null default '{}'::jsonb,
  add column if not exists draft_seo        jsonb,
  add column if not exists status           text not null default 'published' check (status in ('draft','published')),
  add column if not exists draft_updated_at timestamptz,
  add column if not exists draft_updated_by uuid references auth.users(id);

-- Backfill BEFORE the guard/snapshot triggers below exist — every existing
-- row's draft_content starts equal to its published content (so the first
-- edit doesn't appear to discard anything), without needing cms.manage/
-- cms.publish JWT claims that a direct migration run doesn't carry, and
-- without seeding spurious revision history rows.
update public.site_sections set draft_content = content, draft_seo = seo where draft_content is null;

create table public.site_section_revisions (
  id          uuid primary key default gen_random_uuid(),
  section_id  uuid not null references public.site_sections(id) on delete cascade,
  content     jsonb,
  seo         jsonb,
  is_active   boolean,
  sort_order  int,
  action      text not null check (action in ('draft_saved','published','unpublished')),
  actor_id    uuid,
  actor_email text,
  created_at  timestamptz not null default now()
);
create index site_section_revisions_section_idx on public.site_section_revisions(section_id, created_at desc);

alter table public.site_section_revisions enable row level security;
create policy platform_admin_read on public.site_section_revisions for select
  using (app.has_platform_perm('cms.manage'));

create or replace function app.snapshot_site_section_revision() returns trigger
language plpgsql security definer set search_path = public, app as $fn$
declare
  v_claims jsonb := nullif(current_setting('request.jwt.claims', true), '')::jsonb;
  v_action text;
begin
  if new.draft_content is distinct from old.draft_content or new.draft_seo is distinct from old.draft_seo then
    v_action := 'draft_saved';
  elsif new.content is distinct from old.content or new.seo is distinct from old.seo then
    v_action := 'published';
  elsif new.is_active = false and old.is_active = true then
    v_action := 'unpublished';
  else
    return new;
  end if;

  insert into public.site_section_revisions (section_id, content, seo, is_active, sort_order, action, actor_id, actor_email)
  values (new.id, new.content, new.seo, new.is_active, new.sort_order, v_action,
    (v_claims #>> '{sub}')::uuid, v_claims #>> '{email}');
  return new;
end
$fn$;

drop trigger if exists snapshot_revision on public.site_sections;
create trigger snapshot_revision after update on public.site_sections
  for each row execute function app.snapshot_site_section_revision();

-- Column-level publish guard: cms.manage may write draft_* only;
-- cms.publish is required to move content/seo/status/is_active (the
-- fields that actually change what the public site renders).
create or replace function app.guard_site_section_publish() returns trigger
language plpgsql as $fn$
begin
  if (new.content, new.seo, new.status, new.is_active) is distinct from (old.content, old.seo, old.status, old.is_active)
     and not app.has_platform_perm('cms.publish') then
    raise exception 'publish permission required' using errcode = 'insufficient_privilege';
  end if;
  if (new.draft_content, new.draft_seo) is distinct from (old.draft_content, old.draft_seo)
     and not app.has_platform_perm('cms.manage') then
    raise exception 'cms permission required' using errcode = 'insufficient_privilege';
  end if;
  return new;
end
$fn$;

drop trigger if exists guard_publish on public.site_sections;
create trigger guard_publish before update on public.site_sections
  for each row execute function app.guard_site_section_publish();

-- Replace the blanket super_admin_all/platform_read policies on
-- site_sections with a finer split now that draft vs publish are two
-- distinct write surfaces (the guard trigger above is the real gate;
-- these RLS policies decide who can attempt a write at all).
drop policy if exists platform_read on public.site_sections;
create policy platform_cms_read on public.site_sections for select
  using (app.has_platform_perm('cms.manage'));
create policy platform_cms_write on public.site_sections for update
  using (app.has_platform_perm('cms.manage') or app.has_platform_perm('cms.publish'));
