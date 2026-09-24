import { notFound } from 'next/navigation';
import { createTenantServerClient } from '@/lib/supabase/tenant-server';
import { gatePortalPage, can } from '@/lib/permissions';
import { LiveRefresh } from '@/components/LiveRefresh';
import { SectionReportButtons } from '@/components/SectionReportButtons';
import { OrdersClient } from './OrdersClient';

export const dynamic = 'force-dynamic';

export default async function OrdersPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const t = await createTenantServerClient(slug);
  if (!t) notFound();

  const { role, perms } = await gatePortalPage(t.client, slug, 'orders.view');

  const { data: orders, error } = await t.client
    .from('orders')
    .select(
      'id, order_number, status, channel, table_label, customer_name, subtotal_cents, tax_cents, total_cents, created_at, order_lines(name_snapshot, qty, line_total_cents, kds_status)',
    )
    .order('created_at', { ascending: false })
    .limit(50);

  return (
    <div className="space-y-6 max-w-5xl">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-black">Orders</h1>
          <p className="text-muted text-xs mt-1">
            Kitchen-stage progress only — take payment in Checkout and cancel with a reason here; an order can&apos;t
            be marked paid without a recorded payment.
          </p>
        </div>
        <SectionReportButtons slug={slug} restaurantName={t.config.restaurantName} domain="orders" label="Orders" />
      </div>
      {error ? (
        <div className="rounded-lg border border-danger/40 bg-danger/10 text-danger p-4 text-xs">
          {error.message}
        </div>
      ) : (
        <>
          <LiveRefresh tables={['orders', 'payments']} channel="orders-page-live" />
          <OrdersClient
            orders={orders ?? []}
            canCancel={can(perms, role, 'orders.cancel')}
            canUpdateStatus={can(perms, role, 'orders.update')}
          />
        </>
      )}
    </div>
  );
}
