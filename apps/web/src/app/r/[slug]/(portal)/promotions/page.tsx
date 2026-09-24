import { notFound } from 'next/navigation';
import { createTenantServerClient } from '@/lib/supabase/tenant-server';
import { gatePortalPage, can } from '@/lib/permissions';
import { PromotionsManager, type Promo, type PromoPerformance } from './PromotionsManager';

export const dynamic = 'force-dynamic';

export default async function PromotionsPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const t = await createTenantServerClient(slug);
  if (!t) notFound();

  const { role, perms } = await gatePortalPage(t.client, slug, 'menu.view');

  const [{ data, error }, { data: perf }, { data: menuItems }] = await Promise.all([
    t.client
      .from('promotions')
      .select(
        'id, name, kind, value_bps, value_cents, code, min_subtotal_cents, active, starts_at, ends_at, days_of_week, start_time, end_time, usage_limit_total, usage_count, auto_apply, bogo_menu_item_id, bogo_buy_qty, bogo_get_qty, bogo_get_discount_bps, created_at',
      )
      .order('created_at', { ascending: false }),
    t.client.rpc('promotion_performance'),
    t.client.from('menu_items').select('id, name').order('name'),
  ]);

  return (
    <div className="space-y-6 max-w-4xl">
      <div>
        <h1 className="text-xl font-black">Promotions</h1>
        <p className="text-muted text-xs mt-1">
          Discount rules for the counter and the guest QR storefront. A promo with a code is
          applied when a guest enters it; mark one &quot;Auto-apply&quot; to have it fire on its
          own (no code needed) whenever an order is eligible; a promo with neither is just a rate
          card for staff to key in manually at the till.
        </p>
      </div>
      {error ? (
        <div className="rounded-lg border border-danger/40 bg-danger/10 text-danger p-4 text-xs">
          {error.message}
        </div>
      ) : (
        <PromotionsManager
          promos={(data ?? []) as Promo[]}
          performance={(perf ?? []) as PromoPerformance[]}
          menuItems={menuItems ?? []}
          canEdit={can(perms, role, 'menu.update')}
        />
      )}
    </div>
  );
}
