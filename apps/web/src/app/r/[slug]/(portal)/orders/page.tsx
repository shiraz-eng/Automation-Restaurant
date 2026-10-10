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

  const [ordersRes, settingsRes, brandRes] = await Promise.all([
    t.client
      .from('orders')
      .select(
        'id, order_number, status, channel, table_label, customer_name, subtotal_cents, discount_cents, tax_cents, total_cents, refunded_cents, paid_at, created_at, order_lines(name_snapshot, variant_name_snapshot, qty, unit_price_cents, line_total_cents, kds_status, modifiers, customer_note), payments(method, amount_cents, reference, status)',
      )
      .order('created_at', { ascending: false })
      // The latest 200; the list sorts, filters and searches them in the browser.
      .limit(200),
    t.client
      .from('business_settings')
      .select('restaurant_name, receipt_config, phone, address, tax_rate_bps, tax_id')
      .eq('id', true)
      .maybeSingle(),
    t.client.rpc('get_brand_kit'),
  ]);

  const orders = ordersRes.data;
  const error = ordersRes.error;
  const settings = settingsRes.data;
  const brandRow = Array.isArray(brandRes.data) ? brandRes.data[0] : brandRes.data;

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
            orders={(orders as any[]) ?? []}
            restaurantName={settings?.restaurant_name || t.config.restaurantName}
            receiptConfig={settings?.receipt_config ?? null}
            brandKit={{
              logoUrl: brandRow?.logo_url ?? null,
              primaryColor: brandRow?.primary_color ?? null,
            }}
            restaurantInfo={{
              address: settings?.address ?? null,
              phone: settings?.phone ?? null,
              taxId: settings?.tax_id ?? null,
              taxRateBps: settings?.tax_rate_bps ?? 0,
            }}
            canCancel={can(perms, role, 'orders.cancel')}
            canUpdateStatus={can(perms, role, 'orders.update')}
            canReopen={can(perms, role, 'orders.reopen')}
          />
        </>
      )}
    </div>
  );
}
