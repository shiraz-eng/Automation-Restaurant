-- ============================================================================
-- 0020_faq_items.sql  (control-plane project)
-- Dedicated FAQ management: categories, reorder, publish/unpublish per item
-- — a flat items[] array inside one site_sections row couldn't support any
-- of that. Same draft/publish split as site_sections (0019). Public read
-- path is new (GET /api/public/faq-items) since FAQ used to be embedded in
-- the 'faq' site_sections row; that row's schema simplifies to eyebrow/title
-- only (apps/web/src/lib/cms/schemas.ts) once this backfill completes.
-- ============================================================================

create table public.faq_items (
  id             uuid primary key default gen_random_uuid(),
  category       text not null default 'General',
  question       text not null,
  answer         text not null,
  draft_question text,
  draft_answer   text,
  status         text not null default 'published' check (status in ('draft','published')),
  is_published   boolean not null default true,
  sort_order     int not null default 0,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create trigger set_updated_at before update on public.faq_items
  for each row execute function app.set_updated_at();

alter table public.faq_items enable row level security;
create policy anon_read_published on public.faq_items for select using (is_published and status = 'published');
create policy platform_cms_read on public.faq_items for select using (app.has_platform_perm('cms.manage'));
create policy platform_cms_write on public.faq_items for all
  using (app.has_platform_perm('cms.manage') or app.has_platform_perm('cms.publish'))
  with check (app.has_platform_perm('cms.manage') or app.has_platform_perm('cms.publish'));

do $$
begin
  create trigger audit after insert or update or delete on public.faq_items
    for each row execute function app.audit_row();
exception when duplicate_object then null;
end $$;

-- One-time backfill: copy today's single 'faq' site_sections row's
-- content.items[] into individual faq_items rows (category='General'),
-- so no existing FAQ content is lost by this migration.
insert into public.faq_items (question, answer, draft_question, draft_answer, category, sort_order, status, is_published)
select
  item ->> 'q',
  item ->> 'a',
  item ->> 'q',
  item ->> 'a',
  'General',
  ord - 1,
  'published',
  true
from public.site_sections,
     jsonb_array_elements(coalesce(content -> 'items', '[]'::jsonb)) with ordinality as t(item, ord)
where slug = 'faq' and section_type = 'faq'
on conflict do nothing;
