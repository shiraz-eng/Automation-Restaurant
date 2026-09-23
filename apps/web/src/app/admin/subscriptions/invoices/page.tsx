import { createControlPlaneServerClient } from '@/lib/supabase/control-plane-server';
import { gateAdminPage } from '@/lib/adminPermissions';
import { InvoicesClient } from './InvoicesClient';

export const dynamic = 'force-dynamic';

export default async function AdminInvoicesPage() {
  const supabase = await createControlPlaneServerClient();
  await gateAdminPage(supabase, 'invoices.view');

  return (
    <div className="space-y-6 max-w-4xl">
      <div>
        <h1 className="text-xl font-black">Invoices</h1>
        <p className="text-ink-muted text-xs mt-1">
          Read live from the payment provider — nothing is stored locally, so this is always current.
        </p>
      </div>
      <InvoicesClient />
    </div>
  );
}
