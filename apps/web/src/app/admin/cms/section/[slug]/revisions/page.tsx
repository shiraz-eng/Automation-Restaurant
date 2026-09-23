import Link from 'next/link';
import { notFound } from 'next/navigation';
import { createControlPlaneServerClient } from '@/lib/supabase/control-plane-server';
import { gateAdminPage } from '@/lib/adminPermissions';
import { AdminCard } from '../../../../_components/ui';
import { formatDateTime } from '@/lib/format';

export const dynamic = 'force-dynamic';

type Revision = {
  id: string;
  action: 'draft_saved' | 'published' | 'unpublished';
  actor_email: string | null;
  created_at: string;
};

const ACTION_LABEL: Record<Revision['action'], string> = {
  draft_saved: 'Draft saved',
  published: 'Published',
  unpublished: 'Unpublished',
};
const ACTION_TONE: Record<Revision['action'], string> = {
  draft_saved: 'text-gold bg-gold/10',
  published: 'text-emerald-400 bg-emerald-400/10',
  unpublished: 'text-red-400 bg-red-400/10',
};

export default async function CmsSectionRevisionsPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const supabase = await createControlPlaneServerClient();
  await gateAdminPage(supabase, 'cms.manage');

  const { data: section } = await supabase.from('site_sections').select('id, slug').eq('slug', slug).maybeSingle();
  if (!section) notFound();

  const { data: revisions } = await supabase
    .from('site_section_revisions')
    .select('id, action, actor_email, created_at')
    .eq('section_id', section.id)
    .order('created_at', { ascending: false })
    .limit(100);

  const rows = (revisions ?? []) as Revision[];

  return (
    <div className="space-y-6 max-w-3xl">
      <div>
        <Link href={`/admin/cms/section/${slug}`} className="text-xs text-gold hover:underline">
          ← Back to editor
        </Link>
        <h1 className="text-xl font-black mt-2">Revision history — {slug}</h1>
      </div>

      {rows.length === 0 ? (
        <AdminCard>No revisions recorded yet.</AdminCard>
      ) : (
        <AdminCard className="p-0 overflow-hidden">
          <table className="w-full text-left text-xs">
            <thead className="text-ink-muted border-b border-white/10">
              <tr>
                <th className="p-3 font-semibold">When</th>
                <th className="p-3 font-semibold">Action</th>
                <th className="p-3 font-semibold">Who</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-b border-white/10 last:border-0">
                  <td className="p-3 text-ink-muted whitespace-nowrap">{formatDateTime(r.created_at)}</td>
                  <td className="p-3">
                    <span className={`text-[10px] font-bold uppercase px-2 py-0.5 rounded-full ${ACTION_TONE[r.action]}`}>
                      {ACTION_LABEL[r.action]}
                    </span>
                  </td>
                  <td className="p-3 text-ink-muted">{r.actor_email ?? 'system'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </AdminCard>
      )}
    </div>
  );
}
