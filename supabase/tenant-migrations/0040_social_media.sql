-- 0040: Social media integration (Instagram) — connected accounts + a
-- draft/approval queue for AI-proposed posts (see schema.sql's matching
-- block for the full design note). Idempotent: safe to re-run.

create table if not exists public.social_accounts (
  id                 uuid primary key default gen_random_uuid(),
  platform           text not null check (platform in ('instagram')),
  account_name       text,
  account_id         text not null,
  access_token       text not null,
  token_expires_at   timestamptz,
  status             text not null default 'connected' check (status in ('connected', 'expired', 'disconnected')),
  connected_by       uuid,
  connected_at       timestamptz not null default now(),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (platform, account_id)
);

create table if not exists public.social_posts (
  id                 uuid primary key default gen_random_uuid(),
  platform           text not null check (platform in ('instagram')),
  account_id         uuid references public.social_accounts(id) on delete set null,
  caption            text not null,
  media_url          text,
  related_type       text check (related_type is null or related_type in ('deal', 'promotion', 'menu_item')),
  related_id         uuid,
  status             text not null default 'draft' check (status in ('draft', 'approved', 'rejected', 'published', 'failed')),
  proposed_by        uuid,
  proposed_by_role   text,
  approved_by        uuid,
  approved_at        timestamptz,
  published_at       timestamptz,
  external_post_id   text,
  error              text,
  created_at         timestamptz not null default now()
);

create index if not exists social_posts_status_idx on public.social_posts(status, created_at desc);

alter table public.social_accounts enable row level security;
alter table public.social_posts enable row level security;

drop policy if exists staff_read on public.social_accounts;
create policy staff_read on public.social_accounts for select
  using (app.has_perm('social.view') or app.can_write());

drop policy if exists staff_write on public.social_accounts;
create policy staff_write on public.social_accounts for all
  using (app.has_perm('social.manage') or app.can_write())
  with check (app.has_perm('social.manage') or app.can_write());

drop policy if exists staff_read on public.social_posts;
create policy staff_read on public.social_posts for select
  using (app.has_perm('social.view') or app.can_write());

drop policy if exists staff_insert on public.social_posts;
create policy staff_insert on public.social_posts for insert
  with check (app.has_perm('social.propose_post') or app.can_write());

drop policy if exists staff_update on public.social_posts;
create policy staff_update on public.social_posts for update
  using (app.has_perm('social.propose_post') or app.has_perm('social.approve_post') or app.can_write())
  with check (app.has_perm('social.propose_post') or app.has_perm('social.approve_post') or app.can_write());

drop trigger if exists audit_social_accounts on public.social_accounts;
create trigger audit_social_accounts after insert or update or delete on public.social_accounts
  for each row execute function app.audit_row();

drop trigger if exists audit_social_posts on public.social_posts;
create trigger audit_social_posts after insert or update or delete on public.social_posts
  for each row execute function app.audit_row();

insert into public.permission_catalog (key, grp, label) values
  ('social.view','Social','View connected social accounts & posts'),
  ('social.manage','Social','Connect/disconnect social accounts'),
  ('social.propose_post','Social','Draft a social media post'),
  ('social.approve_post','Social','Approve & publish a social media post')
on conflict (key) do update set grp = excluded.grp, label = excluded.label;

-- Grant the new keys to the built-in manager role only (owner already has
-- '*'), same as every other permission bundle above — idempotent: adds
-- only whichever of the four keys manager doesn't already have.
update public.roles
set permissions = (
  select array(select distinct unnest(permissions || array['social.view','social.manage','social.propose_post','social.approve_post']))
)
where key = 'manager'
  and not (permissions @> array['social.view','social.manage','social.propose_post','social.approve_post']);
