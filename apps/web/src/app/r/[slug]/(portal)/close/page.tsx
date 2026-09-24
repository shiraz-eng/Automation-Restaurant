import { notFound } from 'next/navigation';
import { createTenantServerClient } from '@/lib/supabase/tenant-server';
import { gatePortalPage, can } from '@/lib/permissions';
import { CashCountPanel, PaymentReconciliationPanel } from './ReconciliationPanels';
import { DayCloseClient, type Closing } from './DayCloseClient';

export const dynamic = 'force-dynamic';

export default async function DayClosePage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const t = await createTenantServerClient(slug);
  if (!t) notFound();
  const { role, perms } = await gatePortalPage(t.client, slug, 'finance.view');

  const { data, error } = await t.client
    .from('daily_closings')
    .select(
      'business_date, status, opening_cash_cents, closing_cash_cents, expected_cash_cents, difference_cents, gross_sales_cents, discounts_cents, refunds_cents, net_sales_cents, order_count, closed_at, reopened_at, note',
    )
    .order('business_date', { ascending: false })
    .limit(30);

  return (
    <div className="space-y-6 max-w-3xl">
      <div>
        <h1 className="text-xl font-black">Day close</h1>
        <p className="text-muted text-xs mt-1">
          Reconcile the till and lock the day. Reopening is permission-controlled and audited.
        </p>
      </div>
      {error ? (
        <div className="rounded-lg border border-danger/40 bg-danger/10 text-danger p-4 text-xs">
          {error.message}
        </div>
      ) : (
        <DayCloseClient
          closings={(data ?? []) as Closing[]}
          canClose={can(perms, role, 'finance.close_day')}
          canReopen={can(perms, role, 'finance.reopen_day')}
        />
      )}
      {can(perms, role, 'finance.reconcile') && <CashCountPanel />}
      {can(perms, role, 'payments.reconcile') && <PaymentReconciliationPanel />}
    </div>
  );
}
