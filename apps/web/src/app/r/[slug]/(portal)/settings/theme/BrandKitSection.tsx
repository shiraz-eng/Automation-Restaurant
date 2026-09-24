import type { SupabaseClient } from '@supabase/supabase-js';
import type { ReceiptConfig, ReceiptContext } from '@/lib/receiptTemplate';
import { BrandKitManager } from './BrandKitManager';
import { ReceiptManager } from './ReceiptManager';

type RecentOrderRow = {
  order_number: number;
  table_label: string | null;
  customer_name: string | null;
  channel: string;
  status: string;
  subtotal_cents: number;
  discount_cents: number;
  tax_cents: number;
  tax_rate_bps: number;
  total_cents: number;
  refunded_cents: number;
  created_at: string;
  paid_at: string | null;
  order_lines: {
    name_snapshot: string;
    variant_name_snapshot: string | null;
    qty: number;
    line_total_cents: number;
    modifiers: { name: string; price_cents: number }[];
    customer_note: string | null;
  }[];
  payments: { method: string; reference: string | null; amount_cents: number; change_cents: number | null; status: string; created_at: string }[];
};

/**
 * Brand Kit + Receipt Customization — the body of the Brand Kit page,
 * shared with generated custom portals (settings.view / settings.update)
 * so both render the exact same screen from the same query.
 */
export async function BrandKitSection({
  client,
  slug,
  restaurantName,
  canEdit,
}: {
  client: SupabaseClient;
  slug: string;
  restaurantName: string;
  canEdit: boolean;
}) {
  const t = { client, config: { restaurantName } };
  const [{ data, error }, { data: recentOrders }] = await Promise.all([
    t.client
      .from('business_settings')
      .select(
        'brand_logo_url, receipt_footer_text, receipt_template_html, receipt_config, address, phone, contact_email, website, tax_registration_number, brand_primary, brand_primary_fg, brand_bg_main, brand_bg_surface, brand_border, brand_text_body, brand_text_muted, brand_radius, brand_appearance, meta_title, plan_tier, plan_features',
      )
      .eq('id', true)
      .maybeSingle(),
    // Realistic preview data (spec: "should use ... realistic existing
    // order data where available") — the single most recent order, so the
    // Receipt Customization preview looks like an actual receipt rather
    // than fabricated numbers whenever this restaurant has taken an order.
    t.client
      .from('orders')
      .select(
        'order_number, table_label, customer_name, channel, status, subtotal_cents, discount_cents, tax_cents, tax_rate_bps, total_cents, refunded_cents, created_at, paid_at, order_lines(name_snapshot, variant_name_snapshot, qty, line_total_cents, modifiers, customer_note), payments(method, reference, amount_cents, change_cents, status, created_at)',
      )
      .order('created_at', { ascending: false })
      .limit(1),
  ]);

  const recent = (recentOrders as unknown as RecentOrderRow[] | null)?.[0] ?? null;
  const previewOrder: ReceiptContext | null = recent
    ? {
        restaurantName: t.config.restaurantName,
        logoUrl: data?.brand_logo_url ?? null,
        primaryColor: data?.brand_primary ?? null,
        address: data?.address ?? null,
        phone: data?.phone ?? null,
        email: data?.contact_email ?? null,
        website: data?.website ?? null,
        taxId: data?.tax_registration_number ?? null,
        orderNumber: recent.order_number,
        tableLabel: recent.table_label,
        customerName: recent.customer_name,
        orderType: recent.channel ? recent.channel.replace('_', ' ') : null,
        createdAt: recent.created_at,
        paidAt: recent.paid_at,
        orderStatus: recent.status ? recent.status.replace('_', ' ') : null,
        lines: recent.order_lines.map((l) => ({
          qty: l.qty,
          name: l.name_snapshot,
          variantName: l.variant_name_snapshot,
          modifiers: l.modifiers,
          notes: l.customer_note,
          unitPriceCents: 0,
          lineTotalCents: l.line_total_cents,
        })),
        subtotalCents: recent.subtotal_cents,
        discountCents: recent.discount_cents,
        taxCents: recent.tax_cents,
        taxRateBps: recent.tax_rate_bps,
        totalCents: recent.total_cents,
        refundedCents: recent.refunded_cents,
        paymentMethod: recent.payments.find((p) => p.status !== 'voided')?.method ?? null,
        paymentReference: recent.payments.find((p) => p.status !== 'voided')?.reference ?? null,
        amountPaidCents: recent.payments.find((p) => p.status !== 'voided')?.amount_cents ?? null,
        changeCents: recent.payments.find((p) => p.status !== 'voided')?.change_cents ?? null,
      }
    : null;

  return (
    <>
        {error ? (
          <div className="rounded-lg border border-danger/40 bg-danger/10 text-danger p-4 text-xs">{error.message}</div>
        ) : (
          <>
            <BrandKitManager
              slug={slug}
              logoUrl={data?.brand_logo_url ?? null}
              metaTitle={data?.meta_title ?? null}
              restaurantName={t.config.restaurantName}
              canEdit={canEdit}
              entitled={!data?.plan_tier || (data.plan_features as string[]).includes('menu.branded')}
            />

            <div>
              <h2 className="text-lg font-black">Receipt Customization</h2>
              <p className="text-muted text-xs mt-1">
                Configure exactly what appears on every printed and PDF receipt this restaurant generates.
              </p>
            </div>
            <ReceiptManager
              slug={slug}
              canEdit={canEdit}
              initialConfig={(data?.receipt_config as ReceiptConfig | null) ?? null}
              restaurantName={t.config.restaurantName}
              logoUrl={data?.brand_logo_url ?? null}
              primaryColor={data?.brand_primary ?? null}
              restaurant={{
                address: data?.address ?? null,
                phone: data?.phone ?? null,
                email: data?.contact_email ?? null,
                website: data?.website ?? null,
                taxId: data?.tax_registration_number ?? null,
              }}
              previewOrder={previewOrder}
              legacyTemplateHtml={data?.receipt_template_html ?? null}
            />
          </>
        )}
    </>
  );
}
