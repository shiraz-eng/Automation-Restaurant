import { notFound } from 'next/navigation';
import { createTenantServerClient } from '@/lib/supabase/tenant-server';
import { gatePortalPage, can } from '@/lib/permissions';
import type { ReceiptConfig as CheckoutClientReceiptConfig } from '@/lib/receiptTemplate';
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

  const [{ data, error }, { data: settings }, { data: menuCategories }, { data: menuItems }, { data: availabilityRows }] = await Promise.all([
    t.client
      .from('orders')
      .select(
        'id, order_number, session_id, table_label, customer_name, channel, status, subtotal_cents, discount_cents, tax_cents, tax_rate_bps, total_cents, refunded_cents, created_at, paid_at, order_lines(id, name_snapshot, variant_name_snapshot, qty, unit_price_cents, line_total_cents, modifiers, customer_note), payments(id, amount_cents, method, reference, tendered_cents, change_cents, status, refunded_cents, created_at)',
      )
      .in('status', UNPAID)
      .order('created_at', { ascending: true }),
    t.client
      .from('business_settings')
      .select('brand_logo_url, brand_primary, receipt_footer_text, receipt_template_html, receipt_config, address, phone, contact_email, website, tax_registration_number')
      .eq('id', true)
      .maybeSingle(),
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
    canCreateOrder
      ? t.client.from('product_availability').select('menu_item_id, variant_id, status')
      : Promise.resolve({ data: null }),
  ]);

  // Layer the recipe-driven engine's computed availability on top of the
  // manual is_available toggle already filtered above — same "absence of
  // a row means untracked, fall back to the manual signal" rule Menu
  // Management/Customer Menu already use, so New Order stops offering
  // something the engine (and, once configured, priority allocation)
  // already knows is out of stock.
  const availByItem = new Map<string, { variant_id: string | null; status: string }[]>();
  for (const r of (availabilityRows ?? []) as { menu_item_id: string; variant_id: string | null; status: string }[]) {
    const arr = availByItem.get(r.menu_item_id) ?? [];
    arr.push(r);
    availByItem.set(r.menu_item_id, arr);
  }
  const menuItemsWithAvailability = (menuItems ?? []).map((it: Record<string, unknown>) => ({
    ...it,
    menu_variants: ((it.menu_variants as Array<Record<string, unknown>>) ?? []).map((v) => ({
      ...v,
      computed_available: (availByItem.get(it.id as string) ?? []).find((r) => r.variant_id === v.id)?.status !== 'unavailable',
    })),
  }));

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
            logoUrl: settings?.brand_logo_url ?? null,
            primaryColor: settings?.brand_primary ?? null,
            footerText: settings?.receipt_footer_text ?? null,
            templateHtml: settings?.receipt_template_html ?? null,
            receiptConfig: (settings?.receipt_config as CheckoutClientReceiptConfig | null) ?? null,
            restaurant: {
              address: settings?.address ?? null,
              phone: settings?.phone ?? null,
              email: settings?.contact_email ?? null,
              website: settings?.website ?? null,
              taxId: settings?.tax_registration_number ?? null,
            },
          }}
          canCreateOrder={canCreateOrder}
          taxRateBps={TAX_RATE_BPS}
          menuCategories={(menuCategories as NewOrderCategory[] | null) ?? []}
          menuItems={menuItemsWithAvailability as unknown as NewOrderItem[]}
        />
      )}
    </div>
  );
}
