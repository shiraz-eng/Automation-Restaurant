import { notFound } from 'next/navigation';
import { createControlPlaneServerClient } from '@/lib/supabase/control-plane-server';
import { gateAdminPage } from '@/lib/adminPermissions';
import { PageSeoClient, type PageSeoRow } from './PageSeoClient';

export const dynamic = 'force-dynamic';

export default async function CmsPageSeoPage({ params }: { params: Promise<{ pageKey: string }> }) {
  const { pageKey } = await params;
  const supabase = await createControlPlaneServerClient();
  const { role, perms } = await gateAdminPage(supabase, 'cms.manage');

  const { data, error } = await supabase.from('cms_page_seo').select('*').eq('page_key', pageKey).maybeSingle();
  if (error || !data) notFound();

  return (
    <div className="space-y-6 max-w-2xl">
      <div>
        <h1 className="text-xl font-black capitalize">{pageKey.replace(/-/g, ' ')} — SEO</h1>
        <p className="text-ink-muted text-xs mt-1">Page metadata, editable independently of body content.</p>
      </div>
      <PageSeoClient row={data as PageSeoRow} role={role} perms={perms} />
    </div>
  );
}
