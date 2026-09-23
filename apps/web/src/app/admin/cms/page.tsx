import Link from 'next/link';
import { createControlPlaneServerClient } from '@/lib/supabase/control-plane-server';
import { gateAdminPage } from '@/lib/adminPermissions';
import { AdminCard } from '../_components/ui';

export const dynamic = 'force-dynamic';

type SectionRow = { id: string; slug: string; section_type: string; is_active: boolean; status: string };
type PageSeoRow = { page_key: string; title: string | null; status: string; content_managed: boolean };
type FaqCount = { count: number };

export default async function AdminCmsIndexPage() {
  const supabase = await createControlPlaneServerClient();
  await gateAdminPage(supabase, 'cms.manage');

  const [{ data: sections }, { data: pages }, { count: faqCount }] = await Promise.all([
    supabase.from('site_sections').select('id, slug, section_type, is_active, status').order('sort_order'),
    supabase.from('cms_page_seo').select('page_key, title, status, content_managed').order('page_key'),
    supabase.from('faq_items').select('id', { count: 'exact', head: true }),
  ]);

  const sectionRows = (sections ?? []) as SectionRow[];
  const pageRows = (pages ?? []) as PageSeoRow[];

  return (
    <div className="space-y-8 max-w-4xl">
      <div>
        <h1 className="text-xl font-black">CMS</h1>
        <p className="text-ink-muted text-xs mt-1">Website Content Manager dashboard</p>
      </div>

      <div>
        <h2 className="font-bold text-sm mb-3">Homepage sections</h2>
        <div className="space-y-2">
          {sectionRows.map((s) => (
            <Link key={s.id} href={`/admin/cms/section/${s.slug}`}>
              <AdminCard className="flex items-center justify-between hover:bg-white/5 transition-colors">
                <div>
                  <div className="font-semibold text-sm flex items-center gap-2">
                    {s.slug}
                    <span className="text-[10px] font-mono text-ink-muted">{s.section_type}</span>
                  </div>
                  <div className="text-ink-muted text-xs">{s.is_active ? 'Published' : 'Unpublished'}</div>
                </div>
                <span className="text-gold text-xs font-semibold">Edit →</span>
              </AdminCard>
            </Link>
          ))}
        </div>
      </div>

      <div>
        <h2 className="font-bold text-sm mb-3">FAQ</h2>
        <Link href="/admin/cms/faq">
          <AdminCard className="flex items-center justify-between hover:bg-white/5 transition-colors">
            <div>
              <div className="font-semibold text-sm">Frequently asked questions</div>
              <div className="text-ink-muted text-xs">{faqCount ?? 0} question(s), categorized</div>
            </div>
            <span className="text-gold text-xs font-semibold">Manage →</span>
          </AdminCard>
        </Link>
      </div>

      <div>
        <h2 className="font-bold text-sm mb-3">Pages (SEO)</h2>
        <div className="space-y-2">
          {pageRows.map((p) => (
            <Link key={p.page_key} href={`/admin/cms/page/${p.page_key}`}>
              <AdminCard className="flex items-center justify-between hover:bg-white/5 transition-colors">
                <div>
                  <div className="font-semibold text-sm capitalize">{p.page_key.replace(/-/g, ' ')}</div>
                  <div className="text-ink-muted text-xs">
                    {p.content_managed ? 'Body + SEO editable' : 'SEO only — body still edited in code'}
                  </div>
                </div>
                <span className="text-gold text-xs font-semibold">Edit →</span>
              </AdminCard>
            </Link>
          ))}
        </div>
      </div>
    </div>
  );
}
