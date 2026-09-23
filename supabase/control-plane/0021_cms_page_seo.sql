-- ============================================================================
-- 0021_cms_page_seo.sql  (control-plane project)
-- Page-level SEO metadata (title/meta description/OG image/slug), separate
-- from section content — every marketing page gets a row here even if its
-- BODY isn't CMS-managed yet (content_managed=false), so SEO is editable
-- everywhere while being honest about which pages' bodies are still
-- hardcoded (converting the rest was already deferred once this session).
-- ============================================================================

create table public.cms_page_seo (
  page_key               text primary key,
  title                  text,
  meta_description       text,
  og_image_url           text,
  canonical_slug         text,
  draft_title            text,
  draft_meta_description text,
  draft_og_image_url     text,
  draft_canonical_slug   text,
  status                 text not null default 'draft' check (status in ('draft','published')),
  content_managed        boolean not null default false,
  updated_at             timestamptz not null default now()
);
create trigger set_updated_at before update on public.cms_page_seo
  for each row execute function app.set_updated_at();

alter table public.cms_page_seo enable row level security;
create policy anon_read_published on public.cms_page_seo for select using (status = 'published');
create policy platform_cms_read on public.cms_page_seo for select using (app.has_platform_perm('cms.manage'));
create policy platform_cms_write on public.cms_page_seo for all
  using (app.has_platform_perm('cms.manage') or app.has_platform_perm('cms.publish'))
  with check (app.has_platform_perm('cms.manage') or app.has_platform_perm('cms.publish'));

insert into public.cms_page_seo (page_key, title, meta_description, status, content_managed) values
  ('home', 'Automation Restaurant — The Operating System for Your Restaurant', 'Orders, kitchen, inventory, suppliers, finance, staff, marketing, analytics and AI — one connected restaurant operating system.', 'published', true),
  ('features', 'Features', null, 'draft', false),
  ('pricing', 'Pricing', null, 'draft', false),
  ('about', 'About', null, 'draft', false),
  ('contact', 'Contact', null, 'draft', false),
  ('use-cases', 'Use Cases', null, 'draft', false),
  ('buyers', 'Buyers', null, 'draft', false)
on conflict (page_key) do nothing;
