'use client';

import { useRef, useState } from 'react';
import { usePortalSupabase } from '@/components/PortalProvider';
import { formatCents } from '@/lib/format';

const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';
const MAX_BYTES = 10 * 1024 * 1024;

type DiffVariant = { name: string; price_cents: number | null; existing_price_cents: number | null; status: 'new' | 'updated' | 'unchanged' | 'missing_price' };
type DiffModifier = { name: string; price_cents: number | null; status: 'new' | 'unchanged' | 'missing_price' };
type DiffModifierGroup = { name: string; modifiers: DiffModifier[]; status: 'new' | 'existing' };
type DiffItem = {
  name: string;
  description: string | null;
  status: 'new' | 'updated' | 'unchanged';
  variants: DiffVariant[];
  modifier_groups: DiffModifierGroup[];
};
type DiffCategory = { name: string; status: 'new' | 'existing'; items: DiffItem[] };
type MenuDiff = {
  summary: { categories: number; items: number; variants: number; modifiers: number; new_items: number; updated_items: number; missing_prices: number };
  categories: DiffCategory[];
};
type ApplyResult = {
  categories_created: number;
  items_created: number;
  items_updated: number;
  variants_created: number;
  variants_updated: number;
  modifier_groups_created: number;
  modifiers_created: number;
  skipped_missing_price: string[];
};

const STATUS_STYLE: Record<string, string> = {
  new: 'bg-ok/15 text-ok',
  updated: 'bg-primary/15 text-primary',
  unchanged: 'bg-muted/15 text-muted',
  missing_price: 'bg-danger/15 text-danger',
};

export function MenuImportPanel({ slug, onClose }: { slug: string; onClose: () => void }) {
  const supabase = usePortalSupabase();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [stage, setStage] = useState<'idle' | 'uploading' | 'extracting' | 'review' | 'applying' | 'done'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [filename, setFilename] = useState('');
  const [draftId, setDraftId] = useState<string | null>(null);
  const [diff, setDiff] = useState<MenuDiff | null>(null);
  const [issues, setIssues] = useState<{ path: string; message: string }[]>([]);
  const [approved, setApproved] = useState<Set<string>>(new Set());
  const [applyResult, setApplyResult] = useState<ApplyResult | null>(null);

  async function authHeader() {
    const {
      data: { session },
    } = await supabase.auth.getSession();
    return { 'Content-Type': 'application/json', Authorization: `Bearer ${session?.access_token ?? ''}` };
  }

  async function handleFile(file: File) {
    setError(null);
    if (file.type !== 'application/pdf') {
      setError('Only PDF files are supported right now.');
      return;
    }
    if (file.size > MAX_BYTES) {
      setError('File must be under 10 MB.');
      return;
    }
    setFilename(file.name);
    setStage('uploading');
    const path = `${Date.now()}-${file.name.replace(/[^a-zA-Z0-9_.-]/g, '_')}`;
    const { error: upErr } = await supabase.storage.from('menu-imports').upload(path, file, { contentType: 'application/pdf' });
    if (upErr) {
      setError(upErr.message);
      setStage('idle');
      return;
    }
    setStage('extracting');
    try {
      const res = await fetch(`${API}/api/ai/menu-import`, {
        method: 'POST',
        headers: await authHeader(),
        body: JSON.stringify({ slug, storagePath: path, filename: file.name }),
      });
      const body = await res.json();
      if (!res.ok) {
        setError(body.message ?? body.error ?? 'Could not read this document.');
        setStage('idle');
        return;
      }
      setDraftId(body.draftId);
      setDiff(body.diff);
      setIssues(body.issues ?? []);
      // Default-approve everything new or updated; a conflict/update still
      // needs a look, but pre-checking it matches "suggested action: update"
      // rather than forcing an extra click for the common case. Items with
      // NO valid price anywhere are left unchecked — nothing to apply yet.
      const initial = new Set<string>();
      (body.diff as MenuDiff).categories.forEach((cat, ci) => {
        cat.items.forEach((item, ii) => {
          const hasAnyPrice = item.variants.some((v) => v.price_cents != null);
          if (hasAnyPrice) initial.add(`${ci}-${ii}`);
        });
      });
      setApproved(initial);
      setStage('review');
    } catch {
      setError('Network error.');
      setStage('idle');
    }
  }

  function toggle(key: string) {
    setApproved((s) => {
      const next = new Set(s);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  async function apply() {
    if (!draftId || approved.size === 0) return;
    setStage('applying');
    setError(null);
    try {
      const res = await fetch(`${API}/api/ai/menu-import/apply`, {
        method: 'POST',
        headers: await authHeader(),
        body: JSON.stringify({ slug, draftId, approvedItemKeys: Array.from(approved) }),
      });
      const body = await res.json();
      if (!res.ok) {
        setError(body.message ?? body.error ?? 'Applying the import failed.');
        setStage('review');
        return;
      }
      setApplyResult(body.result);
      setStage('done');
    } catch {
      setError('Network error.');
      setStage('review');
    }
  }

  async function reject() {
    if (!draftId) return onClose();
    await fetch(`${API}/api/ai/menu-import/reject`, {
      method: 'POST',
      headers: await authHeader(),
      body: JSON.stringify({ slug, draftId }),
    }).catch(() => {});
    onClose();
  }

  return (
    <div className="rounded-lg border border-primary/40 bg-primary/5 p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="font-bold text-sm">Import Menu from File</h2>
        <button onClick={onClose} className="text-muted text-xs">
          ✕
        </button>
      </div>

      {error && <div className="rounded border border-danger/40 bg-danger/10 text-danger p-2.5 text-xs">{error}</div>}

      {stage === 'idle' && (
        <div>
          <p className="text-xs text-muted mb-2">
            Upload a menu PDF. It will be read and turned into a draft you review and approve — nothing is added to your
            live menu until you approve it.
          </p>
          <input
            ref={fileInputRef}
            type="file"
            accept="application/pdf"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) handleFile(f);
            }}
          />
          <button
            onClick={() => fileInputRef.current?.click()}
            className="rounded bg-primary text-primary-fg font-bold px-3 py-1.5 text-xs"
          >
            Choose PDF…
          </button>
        </div>
      )}

      {(stage === 'uploading' || stage === 'extracting') && (
        <p className="text-xs text-muted">
          {stage === 'uploading' ? `Uploading ${filename}…` : 'Reading the document and extracting the menu structure…'}
        </p>
      )}

      {(stage === 'review' || stage === 'applying') && diff && (
        <div className="space-y-3">
          <div className="text-xs">
            Found <strong>{diff.summary.categories}</strong> categories, <strong>{diff.summary.items}</strong> items,{' '}
            <strong>{diff.summary.variants}</strong> variants, <strong>{diff.summary.modifiers}</strong> modifiers —{' '}
            <span className="text-ok font-semibold">{diff.summary.new_items} new</span>,{' '}
            <span className="text-primary font-semibold">{diff.summary.updated_items} updated</span>
            {diff.summary.missing_prices > 0 && (
              <span className="text-danger font-semibold">, {diff.summary.missing_prices} missing price(s)</span>
            )}
            .
          </div>
          {issues.length > 0 && (
            <div className="rounded border border-danger/40 bg-danger/10 p-2 text-[11px] text-danger space-y-0.5">
              <div className="font-bold">Action required</div>
              {issues.map((iss, i) => (
                <div key={i}>{iss.message}</div>
              ))}
            </div>
          )}
          <div className="max-h-96 overflow-y-auto space-y-3 border border-border rounded p-2 bg-surface">
            {diff.categories.map((cat, ci) => (
              <div key={ci}>
                <div className="text-xs font-bold flex items-center gap-1.5 mb-1">
                  {cat.name}
                  <span className={`text-[10px] font-bold uppercase px-1.5 py-0.5 rounded ${STATUS_STYLE[cat.status]}`}>{cat.status}</span>
                </div>
                <div className="space-y-1 pl-3">
                  {cat.items.map((item, ii) => {
                    const key = `${ci}-${ii}`;
                    const hasAnyPrice = item.variants.some((v) => v.price_cents != null);
                    return (
                      <label key={ii} className="flex items-start gap-2 text-xs py-1 border-b border-border/40 last:border-0">
                        <input
                          type="checkbox"
                          className="mt-0.5"
                          checked={approved.has(key)}
                          disabled={!hasAnyPrice || stage === 'applying'}
                          onChange={() => toggle(key)}
                        />
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-1.5 flex-wrap">
                            <span className="font-semibold">{item.name}</span>
                            <span className={`text-[10px] font-bold uppercase px-1.5 py-0.5 rounded ${STATUS_STYLE[item.status]}`}>{item.status}</span>
                          </div>
                          <div className="text-[11px] text-muted">
                            {item.variants.map((v, vi) => (
                              <span key={vi} className="mr-2">
                                {v.name}:{' '}
                                {v.price_cents == null ? (
                                  <span className="text-danger font-semibold">missing price</span>
                                ) : v.status === 'updated' ? (
                                  <span>
                                    <span className="line-through">{formatCents(v.existing_price_cents ?? 0)}</span> →{' '}
                                    <span className="font-semibold text-primary">{formatCents(v.price_cents)}</span>
                                  </span>
                                ) : (
                                  formatCents(v.price_cents)
                                )}
                              </span>
                            ))}
                          </div>
                          {item.modifier_groups.length > 0 && (
                            <div className="text-[11px] text-muted">
                              {item.modifier_groups.map((g) => `${g.name}: ${g.modifiers.map((m) => m.name).join(', ')}`).join(' · ')}
                            </div>
                          )}
                        </div>
                      </label>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
          <div className="flex gap-2">
            <button
              onClick={apply}
              disabled={approved.size === 0 || stage === 'applying'}
              className="rounded bg-primary text-primary-fg font-bold px-3 py-1.5 text-xs disabled:opacity-50"
            >
              {stage === 'applying' ? 'Applying…' : `Approve ${approved.size} Selected`}
            </button>
            <button onClick={reject} disabled={stage === 'applying'} className="rounded border border-danger text-danger px-3 py-1.5 text-xs font-semibold">
              Reject All
            </button>
          </div>
        </div>
      )}

      {stage === 'done' && applyResult && (
        <div className="space-y-2 text-xs">
          <p className="text-ok font-semibold">Menu import applied.</p>
          <ul className="list-disc pl-4 text-muted">
            <li>
              {applyResult.categories_created} categor{applyResult.categories_created === 1 ? 'y' : 'ies'} created
            </li>
            <li>
              {applyResult.items_created} item(s) created, {applyResult.items_updated} updated
            </li>
            <li>
              {applyResult.variants_created} variant(s) created, {applyResult.variants_updated} updated
            </li>
            <li>
              {applyResult.modifier_groups_created} modifier group(s), {applyResult.modifiers_created} modifier option(s) created
            </li>
          </ul>
          {applyResult.skipped_missing_price.length > 0 && (
            <div className="text-danger">
              Skipped (no price provided): {applyResult.skipped_missing_price.join(', ')}
            </div>
          )}
          <button onClick={onClose} className="rounded border border-border px-3 py-1.5 text-xs font-semibold mt-1">
            Close
          </button>
        </div>
      )}
    </div>
  );
}
