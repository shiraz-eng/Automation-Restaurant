import { createControlPlaneServerClient } from '@/lib/supabase/control-plane-server';
import { gateAdminPage } from '@/lib/adminPermissions';
import { FaqManager, type FaqItemRow } from './FaqManager';

export const dynamic = 'force-dynamic';

export default async function AdminCmsFaqPage() {
  const supabase = await createControlPlaneServerClient();
  const { role, perms } = await gateAdminPage(supabase, 'cms.manage');

  const { data, error } = await supabase.from('faq_items').select('*').order('sort_order');

  return (
    <div className="space-y-6 max-w-3xl">
      <div>
        <h1 className="text-xl font-black">FAQ</h1>
        <p className="text-ink-muted text-xs mt-1">Categorized, individually publishable questions shown on the public FAQ section.</p>
      </div>

      {error && (
        <div className="rounded-lg border border-red-500/40 bg-red-500/10 text-red-400 p-4 text-xs">{error.message}</div>
      )}

      <FaqManager items={(data ?? []) as FaqItemRow[]} role={role} perms={perms} />
    </div>
  );
}
