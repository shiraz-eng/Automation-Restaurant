'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { createControlPlaneBrowserClient } from '@/lib/supabase/control-plane-client';
import { canAdmin } from '@/lib/adminPermissions';
import { AdminButton, AdminCard, AdminField, AdminInput, AdminTextarea } from '../../../_components/ui';

export type PageSeoRow = {
  page_key: string;
  title: string | null;
  meta_description: string | null;
  og_image_url: string | null;
  canonical_slug: string | null;
  draft_title: string | null;
  draft_meta_description: string | null;
  draft_og_image_url: string | null;
  draft_canonical_slug: string | null;
  status: 'draft' | 'published';
  content_managed: boolean;
};

export function PageSeoClient({ row, role, perms }: { row: PageSeoRow; role: string; perms: string[] }) {
  const router = useRouter();
  const supabase = createControlPlaneBrowserClient();
  const [title, setTitle] = useState(row.draft_title ?? row.title ?? '');
  const [desc, setDesc] = useState(row.draft_meta_description ?? row.meta_description ?? '');
  const [ogImage, setOgImage] = useState(row.draft_og_image_url ?? row.og_image_url ?? '');
  const [slug, setSlug] = useState(row.draft_canonical_slug ?? row.canonical_slug ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canPublish = canAdmin(perms, role, 'cms.publish');

  async function saveDraft() {
    setBusy(true);
    setError(null);
    const { error: e } = await supabase
      .from('cms_page_seo')
      .update({ draft_title: title, draft_meta_description: desc, draft_og_image_url: ogImage, draft_canonical_slug: slug })
      .eq('page_key', row.page_key);
    setBusy(false);
    if (e) return setError(e.message);
    router.refresh();
  }

  async function publish() {
    setBusy(true);
    setError(null);
    const { error: e } = await supabase
      .from('cms_page_seo')
      .update({ title, meta_description: desc, og_image_url: ogImage, canonical_slug: slug, status: 'published' })
      .eq('page_key', row.page_key);
    setBusy(false);
    if (e) return setError(e.message);
    router.refresh();
  }

  return (
    <AdminCard className="space-y-3">
      {!row.content_managed && (
        <p className="text-[11px] text-gold bg-gold/10 rounded-lg px-3 py-2">
          This page&rsquo;s body content isn&rsquo;t CMS-managed yet — still edited in code. SEO fields below are live regardless.
        </p>
      )}
      <AdminField label="Page title">
        <AdminInput value={title} onChange={(e) => setTitle(e.target.value)} />
      </AdminField>
      <AdminField label="Meta description">
        <AdminTextarea rows={2} value={desc} onChange={(e) => setDesc(e.target.value)} />
      </AdminField>
      <AdminField label="Open Graph image URL">
        <AdminInput value={ogImage} onChange={(e) => setOgImage(e.target.value)} />
      </AdminField>
      <AdminField label="URL slug">
        <AdminInput value={slug} onChange={(e) => setSlug(e.target.value)} />
      </AdminField>
      {error && <p className="text-red-400 text-xs">{error}</p>}
      <div className="flex flex-wrap gap-2">
        <AdminButton variant="ghost" onClick={saveDraft} disabled={busy}>
          Save Draft
        </AdminButton>
        {canPublish && (
          <AdminButton onClick={publish} disabled={busy} className="!bg-emerald-500 hover:!bg-emerald-400">
            Publish
          </AdminButton>
        )}
      </div>
    </AdminCard>
  );
}
