import { createControlPlaneServerClient } from '@/lib/supabase/control-plane-server';
import { gateAdminPage } from '@/lib/adminPermissions';
import { PlansManager, type PlanDbRow } from './PlansManager';

export const dynamic = 'force-dynamic';

export default async function AdminPlansPage() {
  const supabase = await createControlPlaneServerClient();
  await gateAdminPage(supabase, 'plans.manage');

  const { data, error } = await supabase.from('plans').select('*').order('sort_order');

  return (
    <div className="space-y-6 max-w-4xl">
      <div>
        <h1 className="text-xl font-black">Plans & Pricing</h1>
        <p className="text-ink-muted text-xs mt-1">
          The single source every page (pricing, get-started, tenant billing, the dashboard) reads live — edits here
          show up immediately, no deploy needed.
        </p>
      </div>

      {error && (
        <div className="rounded-lg border border-red-500/40 bg-red-500/10 text-red-400 p-4 text-xs">{error.message}</div>
      )}

      <PlansManager plans={(data ?? []) as PlanDbRow[]} />
    </div>
  );
}
