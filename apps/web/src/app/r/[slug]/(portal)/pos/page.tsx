import { notFound, redirect } from 'next/navigation';
import { createTenantServerClient } from '@/lib/supabase/tenant-server';
import { PosClient } from './PosClient';

export const dynamic = 'force-dynamic';

const TAX_RATE_BPS = 800;

export default async function PosPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const t = await createTenantServerClient(slug);
  if (!t) notFound();

  const {
    data: { user },
  } = await t.client.auth.getUser();
  if (!user) redirect(`/r/${slug}/login`);

  const [{ data: categories }, { data: items, error }] = await Promise.all([
    t.client.from('menu_categories').select('id, name').order('sort_order'),
    t.client
      .from('menu_items')
      .select(
        'id, name, category_id, menu_variants(id, name, price_cents, sort_order, is_available)',
      )
      .eq('is_available', true)
      .order('name'),
  ]);

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-black">Counter POS</h1>
      {error ? (
        <div className="rounded-lg border border-danger/40 bg-danger/10 text-danger p-4 text-xs">
          {error.message}
        </div>
      ) : (
        <PosClient taxRateBps={TAX_RATE_BPS} categories={categories ?? []} items={items ?? []} />
      )}
    </div>
  );
}
