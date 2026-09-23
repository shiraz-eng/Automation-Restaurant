'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { createControlPlaneBrowserClient } from '@/lib/supabase/control-plane-client';
import { canAdmin } from '@/lib/adminPermissions';
import { AdminButton, AdminCard, AdminInput, AdminTextarea } from '../../_components/ui';

export type FaqItemRow = {
  id: string;
  category: string;
  question: string;
  draft_question: string | null;
  answer: string;
  draft_answer: string | null;
  status: 'draft' | 'published';
  is_published: boolean;
  sort_order: number;
};

function ItemRow({
  item,
  onDone,
  canPublish,
  onMove,
  isFirst,
  isLast,
}: {
  item: FaqItemRow;
  onDone: () => void;
  canPublish: boolean;
  onMove: (dir: -1 | 1) => void;
  isFirst: boolean;
  isLast: boolean;
}) {
  const supabase = createControlPlaneBrowserClient();
  const [question, setQuestion] = useState(item.draft_question ?? item.question);
  const [answer, setAnswer] = useState(item.draft_answer ?? item.answer);
  const [category, setCategory] = useState(item.category);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function saveDraft() {
    setBusy(true);
    setError(null);
    const { error: e } = await supabase
      .from('faq_items')
      .update({ draft_question: question, draft_answer: answer, category })
      .eq('id', item.id);
    setBusy(false);
    if (e) return setError(e.message);
    onDone();
  }

  async function publish() {
    setBusy(true);
    setError(null);
    const { error: e } = await supabase
      .from('faq_items')
      .update({ question, answer, status: 'published', is_published: true, category })
      .eq('id', item.id);
    setBusy(false);
    if (e) return setError(e.message);
    onDone();
  }

  async function togglePublished() {
    setBusy(true);
    const { error: e } = await supabase.from('faq_items').update({ is_published: !item.is_published }).eq('id', item.id);
    setBusy(false);
    if (e) return setError(e.message);
    onDone();
  }

  async function remove() {
    if (!confirm('Delete this FAQ item?')) return;
    setBusy(true);
    const { error: e } = await supabase.from('faq_items').delete().eq('id', item.id);
    setBusy(false);
    if (e) return setError(e.message);
    onDone();
  }

  return (
    <AdminCard className="space-y-2">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5 text-[10px] font-bold text-ink-muted">
          <button onClick={() => onMove(-1)} disabled={isFirst} className="disabled:opacity-30" aria-label="Move up">
            ↑
          </button>
          <button onClick={() => onMove(1)} disabled={isLast} className="disabled:opacity-30" aria-label="Move down">
            ↓
          </button>
        </div>
        <div className="flex items-center gap-1.5">
          <span className={`text-[10px] font-bold uppercase px-2 py-0.5 rounded-full ${item.is_published ? 'text-emerald-400 bg-emerald-400/10' : 'text-red-400 bg-red-400/10'}`}>
            {item.is_published ? 'Published' : 'Hidden'}
          </span>
          <button onClick={remove} className="text-red-400 text-xs px-1" aria-label="Delete">
            ✕
          </button>
        </div>
      </div>
      <AdminInput value={category} onChange={(e) => setCategory(e.target.value)} placeholder="Category" className="max-w-xs" />
      <AdminInput value={question} onChange={(e) => setQuestion(e.target.value)} placeholder="Question" />
      <AdminTextarea rows={2} value={answer} onChange={(e) => setAnswer(e.target.value)} placeholder="Answer" />
      {error && <p className="text-red-400 text-xs">{error}</p>}
      <div className="flex flex-wrap items-center gap-2">
        <AdminButton variant="ghost" onClick={saveDraft} disabled={busy}>
          Save Draft
        </AdminButton>
        {canPublish && (
          <>
            <AdminButton onClick={publish} disabled={busy} className="!bg-emerald-500 hover:!bg-emerald-400">
              Publish
            </AdminButton>
            <AdminButton variant="ghost" onClick={togglePublished} disabled={busy}>
              {item.is_published ? 'Hide' : 'Show'}
            </AdminButton>
          </>
        )}
      </div>
    </AdminCard>
  );
}

export function FaqManager({ items, role, perms }: { items: FaqItemRow[]; role: string; perms: string[] }) {
  const router = useRouter();
  const supabase = createControlPlaneBrowserClient();
  const canPublish = canAdmin(perms, role, 'cms.publish');
  const [busy, setBusy] = useState(false);

  function refresh() {
    router.refresh();
  }

  async function addItem() {
    setBusy(true);
    await supabase.from('faq_items').insert({
      category: 'General',
      question: 'New question',
      answer: 'New answer',
      draft_question: 'New question',
      draft_answer: 'New answer',
      status: 'draft',
      is_published: false,
      sort_order: items.length,
    });
    setBusy(false);
    refresh();
  }

  async function move(item: FaqItemRow, dir: -1 | 1) {
    const idx = items.findIndex((i) => i.id === item.id);
    const swapIdx = idx + dir;
    if (swapIdx < 0 || swapIdx >= items.length) return;
    const other = items[swapIdx];
    await Promise.all([
      supabase.from('faq_items').update({ sort_order: other.sort_order }).eq('id', item.id),
      supabase.from('faq_items').update({ sort_order: item.sort_order }).eq('id', other.id),
    ]);
    refresh();
  }

  return (
    <div className="space-y-3">
      {items.map((item, i) => (
        <ItemRow
          key={item.id}
          item={item}
          onDone={refresh}
          canPublish={canPublish}
          onMove={(dir) => move(item, dir)}
          isFirst={i === 0}
          isLast={i === items.length - 1}
        />
      ))}
      <AdminButton variant="ghost" onClick={addItem} disabled={busy}>
        + Add question
      </AdminButton>
    </div>
  );
}
