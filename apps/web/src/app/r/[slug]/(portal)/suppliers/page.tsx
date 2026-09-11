import { notFound } from 'next/navigation';
import { createTenantServerClient } from '@/lib/supabase/tenant-server';
import { gatePortalPage } from '@/lib/permissions';
import { SuppliersManager, type Supplier } from './SuppliersManager';

export const dynamic = 'force-dynamic';

export default async function SuppliersPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const t = await createTenantServerClient(slug);
  if (!t) notFound();

  await gatePortalPage(t.client, slug, 'supplier.view');

  const { data, error } = await t.client
    .from('suppliers')
    .select('id, name, contact_name, email, phone, address, payment_terms, notes, created_at')
    .order('name');

  return (
    <div className="space-y-6 max-w-4xl">
      <div>
        <h1 className="text-xl font-black">Suppliers</h1>
        <p className="text-muted text-xs mt-1">
          Vendors you raise purchase orders against. Receiving a PO adds its quantities to
          inventory.
        </p>
      </div>
      {error ? (
        <div className="rounded-lg border border-danger/40 bg-danger/10 text-danger p-4 text-xs">
          {error.message}
        </div>
      ) : (
        <SuppliersManager suppliers={(data ?? []) as Supplier[]} />
      )}
    </div>
  );
}
