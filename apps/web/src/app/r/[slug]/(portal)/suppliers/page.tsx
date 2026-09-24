import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { createTenantServerClient } from '@/lib/supabase/tenant-server';
import { gatePortalPage, can } from '@/lib/permissions';
import { SectionReportButtons } from '@/components/SectionReportButtons';
import { SuppliersManager, type Supplier } from './SuppliersManager';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Suppliers' };

export default async function SuppliersPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const t = await createTenantServerClient(slug);
  if (!t) notFound();

  const { role, perms } = await gatePortalPage(t.client, slug, 'supplier.view');

  const { data, error } = await t.client
    .from('suppliers')
    .select(
      'id, name, contact_name, email, phone, address, payment_terms, notes, created_at, currency, credit_period_days, preferred_payment_method, is_active',
    )
    .order('name');

  return (
    <div className="space-y-6 max-w-4xl">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-black">Suppliers</h1>
          <p className="text-muted text-xs mt-1">
            Vendors you raise purchase orders against. Receiving a PO adds its quantities to
            inventory.
          </p>
        </div>
        <SectionReportButtons slug={slug} restaurantName={t.config.restaurantName} domain="suppliers" label="Suppliers" />
      </div>
      {error ? (
        <div className="rounded-lg border border-danger/40 bg-danger/10 text-danger p-4 text-xs">
          {error.message}
        </div>
      ) : (
        <SuppliersManager
          suppliers={(data ?? []) as Supplier[]}
          canManage={can(perms, role, 'supplier.manage')}
          canCreate={can(perms, role, 'supplier.manage') || can(perms, role, 'supplier.create')}
          canEdit={can(perms, role, 'supplier.manage') || can(perms, role, 'supplier.update')}
        />
      )}
    </div>
  );
}
