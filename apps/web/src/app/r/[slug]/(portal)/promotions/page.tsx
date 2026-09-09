import { notFound, redirect } from 'next/navigation';
import { createTenantServerClient } from '@/lib/supabase/tenant-server';
import { isManagement } from '@/lib/portals';
import { PromotionsManager, type Promo } from './PromotionsManager';

export const dynamic = 'force-dynamic';

export default async function PromotionsPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const t = await createTenantServerClient(slug);
  if (!t) notFound();

  const {
    data: { user },
  } = await t.client.auth.getUser();
  if (!user) redirect(`/r/${slug}/login`);
  const role = (user.app_metadata as { role?: string }).role ?? 'owner';
  if (!isManagement(role)) redirect(`/r/${slug}`);

  const { data, error } = await t.client
    .from('promotions')
    .select(
      'id, name, kind, value_bps, value_cents, code, min_subtotal_cents, active, starts_at, ends_at, created_at',
    )
    .order('created_at', { ascending: false });

  return (
    <div className="space-y-6 max-w-4xl">
      <div>
        <h1 className="text-xl font-black">Promotions</h1>
        <p className="text-muted text-xs mt-1">
          Discount rules for the counter and the guest QR storefront. A promo with a code is
          applied when a guest enters it; a promo without one is available for staff to apply
          at the till.
        </p>
      </div>
      {error ? (
        <div className="rounded-lg border border-danger/40 bg-danger/10 text-danger p-4 text-xs">
          {error.message}
        </div>
      ) : (
        <PromotionsManager promos={(data ?? []) as Promo[]} />
      )}
    </div>
  );
}
