'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { createControlPlaneBrowserClient } from '@/lib/supabase/control-plane-client';
import { canAdmin } from '@/lib/adminPermissions';
import { AdminButton, AdminCard, AdminField, AdminInput } from '../../_components/ui';
import { HeroFields, FlatListFields, CopyOnlyFields, CtaFields, FaqCopyFields } from './SectionFields';

export type SiteSectionRow = {
  id: string;
  slug: string;
  section_type: string;
  content: unknown;
  draft_content: unknown;
  seo: { title?: string; meta_description?: string } | null;
  draft_seo: { title?: string; meta_description?: string } | null;
  status: 'draft' | 'published';
  is_active: boolean;
  sort_order: number;
};

const FIELD_COMPONENTS: Record<string, React.ComponentType<{ content: never; onChange: (c: never) => void }>> = {
  hero: HeroFields as never,
  flat_list: FlatListFields as never,
  copy_only: CopyOnlyFields as never,
  cta: CtaFields as never,
  faq: FaqCopyFields as never,
};

function toBase64(obj: unknown): string {
  return typeof window === 'undefined' ? '' : window.btoa(unescape(encodeURIComponent(JSON.stringify(obj))));
}

export function SectionEditorClient({ row, role, perms }: { row: SiteSectionRow; role: string; perms: string[] }) {
  const router = useRouter();
  const supabase = createControlPlaneBrowserClient();
  const [draft, setDraft] = useState<never>((row.draft_content ?? row.content) as never);
  const [seoTitle, setSeoTitle] = useState((row.draft_seo ?? row.seo)?.title ?? '');
  const [seoDesc, setSeoDesc] = useState((row.draft_seo ?? row.seo)?.meta_description ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  const canPublish = canAdmin(perms, role, 'cms.publish');
  const hasUnpublishedDraft = JSON.stringify(row.draft_content) !== JSON.stringify(row.content);

  const [debouncedDraft, setDebouncedDraft] = useState(draft);
  useEffect(() => {
    const t = setTimeout(() => setDebouncedDraft(draft), 500);
    return () => clearTimeout(t);
  }, [draft]);

  const previewSrc = useMemo(() => {
    const encoded = toBase64(debouncedDraft);
    return `/admin/cms/preview/${row.slug}?draft=${encoded}`;
  }, [debouncedDraft, row.slug]);

  const FieldComponent = FIELD_COMPONENTS[row.section_type];

  async function saveDraft() {
    setBusy(true);
    setError(null);
    const {
      data: { session },
    } = await supabase.auth.getSession();
    const { error: e } = await supabase
      .from('site_sections')
      .update({
        draft_content: draft,
        draft_seo: { title: seoTitle, meta_description: seoDesc },
        draft_updated_at: new Date().toISOString(),
        draft_updated_by: session?.user?.id ?? null,
      })
      .eq('id', row.id);
    setBusy(false);
    if (e) return setError(e.message);
    setSavedAt(Date.now());
    router.refresh();
  }

  async function publish() {
    setBusy(true);
    setError(null);
    const { error: e } = await supabase
      .from('site_sections')
      .update({
        content: draft,
        seo: { title: seoTitle, meta_description: seoDesc },
        status: 'published',
        is_active: true,
      })
      .eq('id', row.id);
    setBusy(false);
    if (e) return setError(e.message);
    router.refresh();
  }

  async function unpublish() {
    setBusy(true);
    setError(null);
    const { error: e } = await supabase.from('site_sections').update({ is_active: false }).eq('id', row.id);
    setBusy(false);
    if (e) return setError(e.message);
    router.refresh();
  }

  async function discardDraft() {
    setDraft(row.content as never);
    setSeoTitle(row.seo?.title ?? '');
    setSeoDesc(row.seo?.meta_description ?? '');
    setBusy(true);
    setError(null);
    const { error: e } = await supabase
      .from('site_sections')
      .update({ draft_content: row.content, draft_seo: row.seo })
      .eq('id', row.id);
    setBusy(false);
    if (e) return setError(e.message);
    router.refresh();
  }

  return (
    <div className="grid lg:grid-cols-2 gap-4 items-start">
      <div className="space-y-3">
        <AdminCard className="space-y-3">
          <div className="flex items-center justify-between">
            <div>
              <div className="font-bold text-sm">{row.slug}</div>
              <div className="text-[10px] font-mono text-ink-muted">{row.section_type}</div>
            </div>
            <div className="flex items-center gap-1.5">
              <span className={`text-[10px] font-bold uppercase px-2 py-0.5 rounded-full ${row.is_active ? 'text-emerald-400 bg-emerald-400/10' : 'text-red-400 bg-red-400/10'}`}>
                {row.is_active ? 'Published' : 'Unpublished'}
              </span>
              {hasUnpublishedDraft && (
                <span className="text-[10px] font-bold uppercase px-2 py-0.5 rounded-full text-gold bg-gold/10">Unsaved draft</span>
              )}
            </div>
          </div>

          {FieldComponent ? (
            <FieldComponent content={draft} onChange={setDraft} />
          ) : (
            <p className="text-ink-muted text-xs">No editor available for section_type &ldquo;{row.section_type}&rdquo;.</p>
          )}

          <div className="border-t border-white/10 pt-3 space-y-2">
            <div className="text-xs font-semibold">SEO</div>
            <AdminField label="Page title override">
              <AdminInput value={seoTitle} onChange={(e) => setSeoTitle(e.target.value)} />
            </AdminField>
            <AdminField label="Meta description">
              <AdminInput value={seoDesc} onChange={(e) => setSeoDesc(e.target.value)} />
            </AdminField>
          </div>

          {error && <p className="text-red-400 text-xs">{error}</p>}
          <div className="flex flex-wrap items-center gap-2 pt-1">
            <AdminButton onClick={saveDraft} disabled={busy}>
              {busy ? 'Saving…' : 'Save Draft'}
            </AdminButton>
            <AdminButton variant="ghost" onClick={discardDraft} disabled={busy}>
              Discard Draft
            </AdminButton>
            {canPublish ? (
              <>
                <AdminButton onClick={publish} disabled={busy} className="!bg-emerald-500 hover:!bg-emerald-400">
                  Publish
                </AdminButton>
                {row.is_active && (
                  <AdminButton variant="danger" onClick={unpublish} disabled={busy}>
                    Unpublish
                  </AdminButton>
                )}
              </>
            ) : (
              <span className="text-[11px] text-ink-muted">Publishing requires the CMS Publish permission.</span>
            )}
            {savedAt && <span className="text-[11px] text-ink-muted">Draft saved.</span>}
          </div>
        </AdminCard>

        <Link href={`/admin/cms/section/${row.slug}/revisions`} className="text-xs text-gold hover:underline">
          View revision history →
        </Link>
      </div>

      <div className="lg:sticky lg:top-6">
        <div className="text-xs font-semibold text-ink-muted mb-2">Live preview (draft)</div>
        <div className="rounded-xl border border-white/10 overflow-hidden bg-ink" style={{ height: 640 }}>
          <iframe key={previewSrc} src={previewSrc} className="w-full h-full" title="Section preview" />
        </div>
      </div>
    </div>
  );
}
