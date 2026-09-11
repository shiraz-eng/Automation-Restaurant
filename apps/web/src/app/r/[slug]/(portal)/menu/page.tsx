import { notFound } from 'next/navigation';
import { createTenantServerClient } from '@/lib/supabase/tenant-server';
import { gatePortalPage } from '@/lib/permissions';
import { MenuManager } from './MenuManager';

export const dynamic = 'force-dynamic';

export default async function MenuPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const t = await createTenantServerClient(slug);
  if (!t) notFound();

  await gatePortalPage(t.client, slug, 'menu.view');

  const [{ data: categories }, { data: items, error }] = await Promise.all([
    t.client.from('menu_categories').select('id, name').order('sort_order'),
    t.client
      .from('menu_items')
      .select(
        'id, name, price_cents, is_available, category_id, image_url, menu_variants(id, name, price_cents, sku, sort_order, is_available, track_availability, available_qty), modifier_groups(id, name, kind, min_select, max_select, sort_order, modifier_options(id, name, price_cents, is_available, sort_order))',
      )
      .order('name'),
  ]);

  return (
    <div className="space-y-6 max-w-4xl">
      <h1 className="text-xl font-black">Menu</h1>
      {error ? (
        <div className="rounded-lg border border-danger/40 bg-danger/10 text-danger p-4 text-xs">
          {error.message}
        </div>
      ) : (
        <MenuManager categories={categories ?? []} items={items ?? []} />
      )}
    </div>
  );
}
