import type { Metadata } from 'next';
import { createClient } from '@supabase/supabase-js';
import { getTenantConfig } from '@/lib/tenant';
import type { BrandKit } from '@/lib/theme';
import { buildOrderMetadata } from '@/lib/portalMetadata';
import { TrackClient, type TrackedOrder } from './TrackClient';

export const dynamic = 'force-dynamic';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string; orderId: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  return buildOrderMetadata(slug);
}

export default async function TrackPage({
  params,
}: {
  params: Promise<{ slug: string; orderId: string }>;
}) {
  const { slug, orderId } = await params;
  const config = await getTenantConfig(slug);
  if (!config) {
    return (
      <div className="min-h-screen grid place-items-center px-6 text-center text-muted text-sm">
        Restaurant not found.
      </div>
    );
  }

  const anon = createClient(config.url, config.anonKey, {
    auth: { persistSession: false },
  });
  // track_order() returns this one order only to someone holding its id —
  // guests can no longer read the orders table directly (migration 0073).
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(orderId);
  const [{ data: tracked }, { data: brandKitRows }] = await Promise.all([
    isUuid ? anon.rpc('track_order', { p_order_id: orderId }) : Promise.resolve({ data: null }),
    anon.rpc('get_brand_kit'),
  ]);
  const brandKit = (Array.isArray(brandKitRows) ? brandKitRows[0] : brandKitRows) as BrandKit | null;
  const result = tracked as (TrackedOrder & { pickup_counter_portal_id: string | null; counters?: { id: string; name: string }[] }) | null;
  const order = result ? { ...result, counters: undefined } : null;
  const counters = result?.counters ?? [];

  if (!order) {
    return (
      <div className="min-h-screen grid place-items-center px-6 text-center text-muted text-sm">
        Order not found.
      </div>
    );
  }

  return (
    <TrackClient
      slug={slug}
      restaurantName={config.restaurantName}
      supabaseUrl={config.url}
      supabaseAnonKey={config.anonKey}
      initial={order as TrackedOrder}
      counters={counters ?? []}
      initialCounterId={order.pickup_counter_portal_id}
      brandKit={brandKit ?? null}
    />
  );
}
