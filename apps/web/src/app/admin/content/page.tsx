import { createControlPlaneServerClient } from '@/lib/supabase/control-plane-server';
import { gateAdminPage } from '@/lib/adminPermissions';
import { ContentManager, type SiteSectionRow } from './ContentManager';

export const dynamic = 'force-dynamic';

export default async function AdminContentPage() {
  const supabase = await createControlPlaneServerClient();
  await gateAdminPage(supabase, 'cms.manage');

  const { data, error } = await supabase.from('site_sections').select('*').order('sort_order');

  return (
    <div className="space-y-6 max-w-4xl">
      <div>
        <h1 className="text-xl font-black">Site Content</h1>
        <p className="text-ink-muted text-xs mt-1">
          Edits show up live on the marketing site — no deploy needed. Only sections already on the page can be
          edited here (adding a brand-new section layout still needs code).
        </p>
      </div>

      {error && (
        <div className="rounded-lg border border-red-500/40 bg-red-500/10 text-red-400 p-4 text-xs">{error.message}</div>
      )}

      <ContentManager sections={(data ?? []) as SiteSectionRow[]} />
    </div>
  );
}
