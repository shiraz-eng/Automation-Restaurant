import { notFound } from 'next/navigation';
import { createControlPlaneServerClient } from '@/lib/supabase/control-plane-server';
import { gateAdminPage } from '@/lib/adminPermissions';
import { SectionEditorClient, type SiteSectionRow } from '../../_components/SectionEditorClient';

export const dynamic = 'force-dynamic';

export default async function CmsSectionPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const supabase = await createControlPlaneServerClient();
  const { role, perms } = await gateAdminPage(supabase, 'cms.manage');

  const { data, error } = await supabase.from('site_sections').select('*').eq('slug', slug).maybeSingle();
  if (error || !data) notFound();

  return (
    <div className="space-y-6 max-w-6xl">
      <div>
        <h1 className="text-xl font-black">Edit section</h1>
        <p className="text-ink-muted text-xs mt-1">Changes save as a draft until you publish — the live site is unaffected until then.</p>
      </div>
      <SectionEditorClient row={data as unknown as SiteSectionRow} role={role} perms={perms} />
    </div>
  );
}
