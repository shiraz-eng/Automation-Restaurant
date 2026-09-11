-- 0019: a real menu-image storage bucket. menu_items.image_url / deals.image_url
-- columns have existed since early scaffolding but nothing ever wrote to
-- them or rendered them — there was no upload path. This adds a public
-- Storage bucket (public: images are served to anonymous storefront guests,
-- same trust level as the rest of the guest-readable menu) with staff-only
-- writes, gated by the same menu.update permission as everything else on
-- the menu.
insert into storage.buckets (id, name, public)
values ('menu-images', 'menu-images', true)
on conflict (id) do nothing;

drop policy if exists "menu-images public read" on storage.objects;
drop policy if exists "menu-images staff write" on storage.objects;

create policy "menu-images public read" on storage.objects for select
  using (bucket_id = 'menu-images');

create policy "menu-images staff write" on storage.objects for all
  using (bucket_id = 'menu-images' and (app.has_perm('menu.update') or app.can_write()))
  with check (bucket_id = 'menu-images' and (app.has_perm('menu.update') or app.can_write()));
