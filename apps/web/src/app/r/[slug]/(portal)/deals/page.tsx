import { notFound } from 'next/navigation';
import { createTenantServerClient } from '@/lib/supabase/tenant-server';
import { gatePortalPage, can } from '@/lib/permissions';
import { DealsManager, type Deal, type MenuOption } from './DealsManager';

export const dynamic = 'force-dynamic';

export default async function DealsPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const t = await createTenantServerClient(slug);
  if (!t) notFound();
  const { role, perms } = await gatePortalPage(t.client, slug, 'deals.view');

  const [{ data: deals, error }, { data: items }] = await Promise.all([
    t.client
      .from('deals')
      .select(
        'id, name, description, image_url, price_cents, is_available, track_availability, available_qty, starts_at, ends_at, sort_order, deal_components(id, menu_item_id, variant_id, qty, sort_order), deal_option_groups(id, name, min_select, max_select, sort_order, deal_option_items(id, menu_item_id, variant_id, qty, price_adjustment_cents, is_default, sort_order))',
      )
      .order('sort_order'),
    t.client
      .from('menu_items')
      .select('id, name, menu_variants(id, name, price_cents)')
      .order('name'),
  ]);

  return (
    <div className="space-y-6 max-w-3xl">
      <div>
        <h1 className="text-xl font-black">Deals &amp; Combos</h1>
        <p className="text-muted text-xs mt-1">
          A combo is a fixed price for a set of items. Orders keep the deal and its components.
        </p>
      </div>
      {error ? (
        <div className="rounded-lg border border-danger/40 bg-danger/10 text-danger p-4 text-xs">
          {error.message}
        </div>
      ) : (
        <DealsManager
          deals={(deals ?? []) as Deal[]}
          menu={(items ?? []) as unknown as MenuOption[]}
          canEdit={can(perms, role, 'deals.update')}
          canCreate={can(perms, role, 'deals.update') || can(perms, role, 'deals.create')}
          canArchive={can(perms, role, 'deals.update') || can(perms, role, 'deals.archive')}
        />
      )}
    </div>
  );
}
