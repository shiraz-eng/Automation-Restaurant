import { notFound } from 'next/navigation';
import { createTenantServerClient } from '@/lib/supabase/tenant-server';
import { gatePortalPage, can } from '@/lib/permissions';
import { CheckoutClient, type Bill } from './CheckoutClient';

export const dynamic = 'force-dynamic';

const UNPAID = ['pending', 'in_kitchen', 'ready', 'served'];

export default async function CheckoutPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const t = await createTenantServerClient(slug);
  if (!t) notFound();
  const { role, perms } = await gatePortalPage(t.client, slug, 'payments.view');

  const { data, error } = await t.client
    .from('orders')
    .select(
      'id, order_number, session_id, table_label, customer_name, status, subtotal_cents, discount_cents, tax_cents, total_cents, refunded_cents, created_at, order_lines(id, name_snapshot, qty, unit_price_cents, line_total_cents), payments(id, amount_cents, method, status, refunded_cents, created_at)',
    )
    .in('status', UNPAID)
    .order('created_at', { ascending: true });

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
        />
      )}
    </div>
  );
}
