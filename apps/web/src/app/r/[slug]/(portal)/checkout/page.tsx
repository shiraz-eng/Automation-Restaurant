import { notFound } from 'next/navigation';
import { createTenantServerClient } from '@/lib/supabase/tenant-server';
import { gatePortalPage, can } from '@/lib/permissions';
import { CheckoutClient, type Bill, type NewOrderCategory, type NewOrderItem } from './CheckoutClient';

export const dynamic = 'force-dynamic';

const UNPAID = ['pending', 'in_kitchen', 'ready', 'served'];
const TAX_RATE_BPS = 800;

export default async function CheckoutPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const t = await createTenantServerClient(slug);
  if (!t) notFound();
  const { role, perms } = await gatePortalPage(t.client, slug, 'payments.view');
  const canCreateOrder = can(perms, role, 'orders.create');

  const [{ data, error }, { data: settings }, { data: menuCategories }, { data: menuItems }] = await Promise.all([
    t.client
      .from('orders')
      .select(
        'id, order_number, session_id, table_label, customer_name, status, subtotal_cents, discount_cents, tax_cents, total_cents, refunded_cents, created_at, order_lines(id, name_snapshot, qty, unit_price_cents, line_total_cents), payments(id, amount_cents, method, status, refunded_cents, created_at)',
      )
      .in('status', UNPAID)
      .order('created_at', { ascending: true }),
    t.client.from('business_settings').select('receipt_logo_url, receipt_footer_text, receipt_template_html').eq('id', true).maybeSingle(),
    canCreateOrder
      ? t.client.from('menu_categories').select('id, name').order('sort_order')
      : Promise.resolve({ data: null }),
    canCreateOrder
      ? t.client
          .from('menu_items')
          .select('id, name, category_id, menu_variants(id, name, price_cents, sort_order, is_available)')
          .eq('is_available', true)
          .order('name')
      : Promise.resolve({ data: null }),
  ]);

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-black">Checkout</h1>
      <p className="text-muted text-xs -mt-3">Open a bill, take payment, issue a refund.</p>
      {error ? (
        <div className="rounded-lg border border-danger/40 bg-danger/10 text-danger p-4 text-xs">
          {error.message}
        </div>
      ) : (
        <CheckoutClient
          restaurantName={t.config.restaurantName}
          initial={(data ?? []) as Bill[]}
          canRefund={can(perms, role, 'payments.refund')}
          canVoid={can(perms, role, 'payments.void')}
          canDiscount={can(perms, role, 'orders.apply_discount')}
          canCancel={can(perms, role, 'orders.cancel')}
          receipt={{
            logoUrl: settings?.receipt_logo_url ?? null,
            footerText: settings?.receipt_footer_text ?? null,
            templateHtml: settings?.receipt_template_html ?? null,
          }}
          canCreateOrder={canCreateOrder}
          taxRateBps={TAX_RATE_BPS}
          menuCategories={(menuCategories as NewOrderCategory[] | null) ?? []}
          menuItems={(menuItems as unknown as NewOrderItem[] | null) ?? []}
        />
      )}
    </div>
  );
}
