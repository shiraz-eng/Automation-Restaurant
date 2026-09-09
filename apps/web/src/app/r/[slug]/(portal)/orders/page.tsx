import { notFound, redirect } from 'next/navigation';
import { createTenantServerClient } from '@/lib/supabase/tenant-server';
import { OrdersClient } from './OrdersClient';

export const dynamic = 'force-dynamic';

export default async function OrdersPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const t = await createTenantServerClient(slug);
  if (!t) notFound();

  const {
    data: { user },
  } = await t.client.auth.getUser();
  if (!user) redirect(`/r/${slug}/login`);

  const { data: orders, error } = await t.client
    .from('orders')
    .select(
      'id, order_number, status, channel, table_label, customer_name, subtotal_cents, tax_cents, total_cents, created_at, order_lines(name_snapshot, qty, line_total_cents, kds_status)',
    )
    .order('created_at', { ascending: false })
    .limit(50);

  return (
    <div className="space-y-6 max-w-5xl">
      <h1 className="text-xl font-black">Orders</h1>
      {error ? (
        <div className="rounded-lg border border-danger/40 bg-danger/10 text-danger p-4 text-xs">
          {error.message}
        </div>
      ) : (
        <OrdersClient orders={orders ?? []} />
      )}
    </div>
  );
}
