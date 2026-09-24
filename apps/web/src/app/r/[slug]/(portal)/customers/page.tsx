import { notFound } from 'next/navigation';
import { createTenantServerClient } from '@/lib/supabase/tenant-server';
import { gatePortalPage, can } from '@/lib/permissions';
import { CustomersManager } from './CustomersManager';

export const dynamic = 'force-dynamic';

export default async function CustomersPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const t = await createTenantServerClient(slug);
  if (!t) notFound();
  const { role, perms } = await gatePortalPage(t.client, slug, 'customers.view');

  return (
    <div className="space-y-4 max-w-5xl">
      <div>
        <h1 className="text-xl font-black">Customers</h1>
        <p className="text-muted text-xs mt-1">
          Your regulars — contact details, preferences and booking history (matched from reservations by phone number).
        </p>
      </div>
      <CustomersManager canCreate={can(perms, role, 'customers.create')} canUpdate={can(perms, role, 'customers.update')} />
    </div>
  );
}
