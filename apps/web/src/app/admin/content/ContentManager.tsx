'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { createControlPlaneBrowserClient } from '@/lib/supabase/control-plane-client';
import { AdminButton, AdminCard, AdminField, AdminInput, AdminTextarea } from '../_components/ui';
import type { HeroContent, FlatListContent, FaqContent, CtaContent, CopyOnlyContent } from '@/lib/cms/schemas';

export type SiteSectionRow = {
  id: string;
  slug: string;
  section_type: string;
  content: unknown;
  is_active: boolean;
  sort_order: number;
};

const BUCKET = 'site-assets';

function useImageUpload() {
  const supabase = createControlPlaneBrowserClient();
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function upload(file: File): Promise<string | null> {
    setUploading(true);
    setError(null);
    const ext = file.name.split('.').pop() ?? 'jpg';
    const path = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
    const { error: upErr } = await supabase.storage.from(BUCKET).upload(path, file, { contentType: file.type });
    setUploading(false);
    if (upErr) {
      setError(upErr.message);
      return null;
    }
    const {
      data: { publicUrl },
    } = supabase.storage.from(BUCKET).getPublicUrl(path);
    return publicUrl;
  }

  return { upload, uploading, error };
}

function ImageField({ label, src, alt, onSrcChange, onAltChange }: { label: string; src: string; alt: string; onSrcChange: (v: string) => void; onAltChange: (v: string) => void }) {
  const { upload, uploading, error } = useImageUpload();
  return (
    <div className="space-y-2">
      <div className="text-xs font-semibold">{label}</div>
      <div className="flex items-center gap-3">
        {src && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={src} alt="" className="h-16 w-24 object-cover rounded border border-white/10" />
        )}
        <label className="text-xs font-semibold text-gold cursor-pointer">
          {uploading ? 'Uploading…' : 'Replace image'}
          <input
            type="file"
            accept="image/jpeg,image/png,image/webp"
            className="hidden"
            disabled={uploading}
            onChange={async (e) => {
              const file = e.target.files?.[0];
              e.target.value = '';
              if (!file) return;
              const url = await upload(file);
              if (url) onSrcChange(url);
            }}
          />
        </label>
      </div>
      {error && <p className="text-red-400 text-xs">{error}</p>}
      <AdminField label="Image URL (or upload above)">
        <AdminInput value={src} onChange={(e) => onSrcChange(e.target.value)} />
      </AdminField>
      <AdminField label="Alt text">
        <AdminInput value={alt} onChange={(e) => onAltChange(e.target.value)} />
      </AdminField>
    </div>
  );
}

function linesToArray(text: string): string[] {
  return text.split('\n').map((s) => s.trim()).filter(Boolean);
}

/** Common footer: active toggle, sort order, save/cancel — shared by every
 *  per-type editor below so each one only needs to build its own fields. */
function EditorShell({
  isActive,
  sortOrder,
  onActiveChange,
  onSortOrderChange,
  onSave,
  onCancel,
  busy,
  error,
  children,
}: {
  isActive: boolean;
  sortOrder: number;
  onActiveChange: (v: boolean) => void;
  onSortOrderChange: (v: number) => void;
  onSave: () => void;
  onCancel: () => void;
  busy: boolean;
  error: string | null;
  children: React.ReactNode;
}) {
  return (
    <AdminCard className="space-y-3">
      {children}
      <div className="grid grid-cols-2 gap-3 pt-2 border-t border-white/10">
        <AdminField label="Sort order (position on the page)">
          <AdminInput type="number" value={sortOrder} onChange={(e) => onSortOrderChange(Number(e.target.value))} />
        </AdminField>
        <label className="flex items-center gap-2 text-xs font-semibold self-end pb-2">
          <input type="checkbox" checked={isActive} onChange={(e) => onActiveChange(e.target.checked)} />
          Active (shown on the site)
        </label>
      </div>
      {error && <p className="text-red-400 text-xs">{error}</p>}
      <div className="flex gap-2">
        <AdminButton onClick={onSave} disabled={busy}>
          {busy ? 'Saving…' : 'Save changes'}
        </AdminButton>
        <AdminButton variant="ghost" onClick={onCancel} disabled={busy}>
          Cancel
        </AdminButton>
      </div>
    </AdminCard>
  );
}

function HeroEditor({ row, onDone }: { row: SiteSectionRow; onDone: () => void }) {
  const [c, setC] = useState(row.content as HeroContent);
  const [meta, setMeta] = useState({ isActive: row.is_active, sortOrder: row.sort_order });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const supabase = createControlPlaneBrowserClient();

  async function save() {
    setBusy(true);
    setError(null);
    const { error: e } = await supabase
      .from('site_sections')
      .update({ content: c, is_active: meta.isActive, sort_order: meta.sortOrder })
      .eq('id', row.id);
    setBusy(false);
    if (e) setError(e.message);
    else onDone();
  }

  return (
    <EditorShell {...meta} onActiveChange={(v) => setMeta((m) => ({ ...m, isActive: v }))} onSortOrderChange={(v) => setMeta((m) => ({ ...m, sortOrder: v }))} onSave={save} onCancel={onDone} busy={busy} error={error}>
      <AdminField label="Badge">
        <AdminInput value={c.badge} onChange={(e) => setC({ ...c, badge: e.target.value })} />
      </AdminField>
      <AdminField label="Headline">
        <AdminInput value={c.headline} onChange={(e) => setC({ ...c, headline: e.target.value })} />
      </AdminField>
      <AdminField label="Subhead">
        <AdminTextarea rows={2} value={c.subhead} onChange={(e) => setC({ ...c, subhead: e.target.value })} />
      </AdminField>
      <div className="grid grid-cols-2 gap-3">
        <AdminField label="Primary button label">
          <AdminInput value={c.primaryCta.label} onChange={(e) => setC({ ...c, primaryCta: { ...c.primaryCta, label: e.target.value } })} />
        </AdminField>
        <AdminField label="Primary button link">
          <AdminInput value={c.primaryCta.href} onChange={(e) => setC({ ...c, primaryCta: { ...c.primaryCta, href: e.target.value } })} />
        </AdminField>
        <AdminField label="Secondary button label">
          <AdminInput value={c.secondaryCta.label} onChange={(e) => setC({ ...c, secondaryCta: { ...c.secondaryCta, label: e.target.value } })} />
        </AdminField>
        <AdminField label="Secondary button link">
          <AdminInput value={c.secondaryCta.href} onChange={(e) => setC({ ...c, secondaryCta: { ...c.secondaryCta, href: e.target.value } })} />
        </AdminField>
      </div>
      <AdminField label="Connected modules (one per line)">
        <AdminTextarea rows={4} value={c.connects.join('\n')} onChange={(e) => setC({ ...c, connects: linesToArray(e.target.value) })} />
      </AdminField>
      <ImageField label="Hero image" src={c.image.src} alt={c.image.alt} onSrcChange={(src) => setC({ ...c, image: { ...c.image, src } })} onAltChange={(alt) => setC({ ...c, image: { ...c.image, alt } })} />
      <AdminField label="Kitchen Display card — tickets (table|status, one per line)">
        <AdminTextarea
          rows={4}
          value={c.kitchenTickets.map((t) => `${t.table}|${t.status}`).join('\n')}
          onChange={(e) =>
            setC({
              ...c,
              kitchenTickets: linesToArray(e.target.value).map((l) => {
                const [table, status] = l.split('|');
                return { table: (table ?? '').trim(), status: (status ?? '').trim() };
              }),
            })
          }
        />
      </AdminField>
      <div className="grid grid-cols-2 gap-3">
        <AdminField label="Inventory alert — title">
          <AdminInput value={c.inventoryAlert.title} onChange={(e) => setC({ ...c, inventoryAlert: { ...c.inventoryAlert, title: e.target.value } })} />
        </AdminField>
        <AdminField label="Inventory alert — text">
          <AdminInput value={c.inventoryAlert.text} onChange={(e) => setC({ ...c, inventoryAlert: { ...c.inventoryAlert, text: e.target.value } })} />
        </AdminField>
      </div>
      <div className="grid grid-cols-3 gap-3">
        <AdminField label="AI card — title">
          <AdminInput value={c.aiRecommendation.title} onChange={(e) => setC({ ...c, aiRecommendation: { ...c.aiRecommendation, title: e.target.value } })} />
        </AdminField>
        <AdminField label="AI card — text">
          <AdminInput value={c.aiRecommendation.text} onChange={(e) => setC({ ...c, aiRecommendation: { ...c.aiRecommendation, text: e.target.value } })} />
        </AdminField>
        <AdminField label="AI card — link text">
          <AdminInput value={c.aiRecommendation.linkText} onChange={(e) => setC({ ...c, aiRecommendation: { ...c.aiRecommendation, linkText: e.target.value } })} />
        </AdminField>
      </div>
    </EditorShell>
  );
}

function FlatListEditor({ row, onDone }: { row: SiteSectionRow; onDone: () => void }) {
  const [c, setC] = useState(row.content as FlatListContent);
  const [meta, setMeta] = useState({ isActive: row.is_active, sortOrder: row.sort_order });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const supabase = createControlPlaneBrowserClient();

  async function save() {
    setBusy(true);
    setError(null);
    const { error: e } = await supabase.from('site_sections').update({ content: c, is_active: meta.isActive, sort_order: meta.sortOrder }).eq('id', row.id);
    setBusy(false);
    if (e) setError(e.message);
    else onDone();
  }

  return (
    <EditorShell {...meta} onActiveChange={(v) => setMeta((m) => ({ ...m, isActive: v }))} onSortOrderChange={(v) => setMeta((m) => ({ ...m, sortOrder: v }))} onSave={save} onCancel={onDone} busy={busy} error={error}>
      <AdminField label="Heading">
        <AdminInput value={c.heading} onChange={(e) => setC({ ...c, heading: e.target.value })} />
      </AdminField>
      <AdminField label="Items (one per line)">
        <AdminTextarea rows={6} value={c.items.join('\n')} onChange={(e) => setC({ ...c, items: linesToArray(e.target.value) })} />
      </AdminField>
    </EditorShell>
  );
}

function CopyOnlyEditor({ row, onDone }: { row: SiteSectionRow; onDone: () => void }) {
  const [c, setC] = useState(row.content as CopyOnlyContent);
  const [meta, setMeta] = useState({ isActive: row.is_active, sortOrder: row.sort_order });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const supabase = createControlPlaneBrowserClient();

  async function save() {
    setBusy(true);
    setError(null);
    const { error: e } = await supabase.from('site_sections').update({ content: c, is_active: meta.isActive, sort_order: meta.sortOrder }).eq('id', row.id);
    setBusy(false);
    if (e) setError(e.message);
    else onDone();
  }

  return (
    <EditorShell {...meta} onActiveChange={(v) => setMeta((m) => ({ ...m, isActive: v }))} onSortOrderChange={(v) => setMeta((m) => ({ ...m, sortOrder: v }))} onSave={save} onCancel={onDone} busy={busy} error={error}>
      <AdminField label="Eyebrow">
        <AdminInput value={c.eyebrow} onChange={(e) => setC({ ...c, eyebrow: e.target.value })} />
      </AdminField>
      <AdminField label="Title">
        <AdminInput value={c.title} onChange={(e) => setC({ ...c, title: e.target.value })} />
      </AdminField>
      <AdminField label="Subtitle">
        <AdminTextarea rows={2} value={c.subtitle} onChange={(e) => setC({ ...c, subtitle: e.target.value })} />
      </AdminField>
    </EditorShell>
  );
}

function CtaEditor({ row, onDone }: { row: SiteSectionRow; onDone: () => void }) {
  const [c, setC] = useState(row.content as CtaContent);
  const [meta, setMeta] = useState({ isActive: row.is_active, sortOrder: row.sort_order });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const supabase = createControlPlaneBrowserClient();

  async function save() {
    setBusy(true);
    setError(null);
    const { error: e } = await supabase.from('site_sections').update({ content: c, is_active: meta.isActive, sort_order: meta.sortOrder }).eq('id', row.id);
    setBusy(false);
    if (e) setError(e.message);
    else onDone();
  }

  return (
    <EditorShell {...meta} onActiveChange={(v) => setMeta((m) => ({ ...m, isActive: v }))} onSortOrderChange={(v) => setMeta((m) => ({ ...m, sortOrder: v }))} onSave={save} onCancel={onDone} busy={busy} error={error}>
      <AdminField label="Headline">
        <AdminInput value={c.headline} onChange={(e) => setC({ ...c, headline: e.target.value })} />
      </AdminField>
      <AdminField label="Subtext">
        <AdminTextarea rows={2} value={c.subtext} onChange={(e) => setC({ ...c, subtext: e.target.value })} />
      </AdminField>
      <div className="grid grid-cols-2 gap-3">
        <AdminField label="Primary button label">
          <AdminInput value={c.primaryCta.label} onChange={(e) => setC({ ...c, primaryCta: { ...c.primaryCta, label: e.target.value } })} />
        </AdminField>
        <AdminField label="Primary button link">
          <AdminInput value={c.primaryCta.href} onChange={(e) => setC({ ...c, primaryCta: { ...c.primaryCta, href: e.target.value } })} />
        </AdminField>
        <AdminField label="Secondary button label">
          <AdminInput value={c.secondaryCta.label} onChange={(e) => setC({ ...c, secondaryCta: { ...c.secondaryCta, label: e.target.value } })} />
        </AdminField>
        <AdminField label="Secondary button link">
          <AdminInput value={c.secondaryCta.href} onChange={(e) => setC({ ...c, secondaryCta: { ...c.secondaryCta, href: e.target.value } })} />
        </AdminField>
      </div>
    </EditorShell>
  );
}

function FaqEditor({ row, onDone }: { row: SiteSectionRow; onDone: () => void }) {
  const [c, setC] = useState(row.content as FaqContent);
  const [meta, setMeta] = useState({ isActive: row.is_active, sortOrder: row.sort_order });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const supabase = createControlPlaneBrowserClient();

  function updateItem(i: number, patch: Partial<{ q: string; a: string }>) {
    setC({ ...c, items: c.items.map((item, idx) => (idx === i ? { ...item, ...patch } : item)) });
  }
  function removeItem(i: number) {
    setC({ ...c, items: c.items.filter((_, idx) => idx !== i) });
  }
  function addItem() {
    setC({ ...c, items: [...c.items, { q: '', a: '' }] });
  }
  function move(i: number, dir: -1 | 1) {
    const j = i + dir;
    if (j < 0 || j >= c.items.length) return;
    const next = [...c.items];
    [next[i], next[j]] = [next[j], next[i]];
    setC({ ...c, items: next });
  }

  async function save() {
    setBusy(true);
    setError(null);
    const { error: e } = await supabase.from('site_sections').update({ content: c, is_active: meta.isActive, sort_order: meta.sortOrder }).eq('id', row.id);
    setBusy(false);
    if (e) setError(e.message);
    else onDone();
  }

  return (
    <EditorShell {...meta} onActiveChange={(v) => setMeta((m) => ({ ...m, isActive: v }))} onSortOrderChange={(v) => setMeta((m) => ({ ...m, sortOrder: v }))} onSave={save} onCancel={onDone} busy={busy} error={error}>
      <div className="grid grid-cols-2 gap-3">
        <AdminField label="Eyebrow">
          <AdminInput value={c.eyebrow} onChange={(e) => setC({ ...c, eyebrow: e.target.value })} />
        </AdminField>
        <AdminField label="Title">
          <AdminInput value={c.title} onChange={(e) => setC({ ...c, title: e.target.value })} />
        </AdminField>
      </div>
      <div className="space-y-3">
        {c.items.map((item, i) => (
          <div key={i} className="rounded border border-white/10 p-2.5 space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-[10px] font-bold text-ink-muted">#{i + 1}</span>
              <div className="flex gap-1">
                <button type="button" onClick={() => move(i, -1)} className="text-ink-muted text-xs px-1" aria-label="Move up">
                  ↑
                </button>
                <button type="button" onClick={() => move(i, 1)} className="text-ink-muted text-xs px-1" aria-label="Move down">
                  ↓
                </button>
                <button type="button" onClick={() => removeItem(i)} className="text-red-400 text-xs px-1" aria-label="Remove">
                  ✕
                </button>
              </div>
            </div>
            <AdminInput value={item.q} onChange={(e) => updateItem(i, { q: e.target.value })} placeholder="Question" />
            <AdminTextarea rows={2} value={item.a} onChange={(e) => updateItem(i, { a: e.target.value })} placeholder="Answer" />
          </div>
        ))}
        <AdminButton variant="ghost" onClick={addItem}>
          + Add question
        </AdminButton>
      </div>
    </EditorShell>
  );
}

const EDITORS: Record<string, React.ComponentType<{ row: SiteSectionRow; onDone: () => void }>> = {
  hero: HeroEditor,
  flat_list: FlatListEditor,
  faq: FaqEditor,
  cta: CtaEditor,
  copy_only: CopyOnlyEditor,
};

export function ContentManager({ sections }: { sections: SiteSectionRow[] }) {
  const router = useRouter();
  const [editingId, setEditingId] = useState<string | null>(null);

  function refresh() {
    setEditingId(null);
    router.refresh();
  }

  return (
    <div className="space-y-3">
      {sections.map((row) => {
        if (editingId === row.id) {
          const Editor = EDITORS[row.section_type];
          if (!Editor) {
            return (
              <AdminCard key={row.id}>
                <p className="text-ink-muted text-xs">No editor for section_type &ldquo;{row.section_type}&rdquo; yet.</p>
                <AdminButton variant="ghost" onClick={() => setEditingId(null)} className="mt-2">
                  Close
                </AdminButton>
              </AdminCard>
            );
          }
          return <Editor key={row.id} row={row} onDone={refresh} />;
        }
        return (
          <AdminCard key={row.id} className={`flex items-center justify-between gap-3 ${!row.is_active ? 'opacity-50' : ''}`}>
            <div>
              <div className="font-bold text-sm flex items-center gap-2">
                {row.slug}
                <span className="text-[10px] font-mono text-ink-muted">{row.section_type}</span>
                {!row.is_active && <span className="text-[10px] font-bold text-red-400">HIDDEN</span>}
              </div>
              <div className="text-ink-muted text-xs">Position {row.sort_order}</div>
            </div>
            <AdminButton variant="ghost" onClick={() => setEditingId(row.id)} disabled={!EDITORS[row.section_type]}>
              Edit
            </AdminButton>
          </AdminCard>
        );
      })}
    </div>
  );
}
