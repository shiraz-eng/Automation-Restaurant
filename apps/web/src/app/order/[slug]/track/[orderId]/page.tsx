import { createClient } from '@supabase/supabase-js';
import { getTenantConfig } from '@/lib/tenant';
import { TrackClient, type TrackedOrder } from './TrackClient';

export const dynamic = 'force-dynamic';

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
  const [{ data: order }, { data: counters }] = await Promise.all([
    anon
      .from('orders')
      .select(
        'id, order_number, table_label, customer_name, status, subtotal_cents, tax_cents, total_cents, created_at, order_lines(name_snapshot, qty, line_total_cents)',
      )
      .eq('id', orderId)
      .maybeSingle(),
    anon.from('portals').select('name').eq('type', 'checkout').eq('status', 'active').order('name'),
  ]);

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
      counters={(counters ?? []).map((c) => c.name)}
    />
  );
}
