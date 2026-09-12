'use client';

import { useRef, useState } from 'react';
import { usePortalSupabase } from '@/components/PortalProvider';
import { formatCents } from '@/lib/format';

const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';
const MAX_BYTES = 10 * 1024 * 1024;

type DiffRow = {
  name: string;
  status: 'new' | 'updated' | 'unchanged';
  existing_item_id: string | null;
  unit: string | null;
  opening_stock: number | null;
  cost_cents_per_unit: number | null;
  existing_cost_cents_per_unit: number | null;
  min_threshold: number | null;
  existing_min_threshold: number | null;
  target_stock: number | null;
  existing_target_stock: number | null;
};
type InventoryDiff = {
  summary: { items: number; new_items: number; updated_items: number };
  items: DiffRow[];
};
type ApplyResult = { items_created: number; items_updated: number; skipped: string[] };

const STATUS_STYLE: Record<string, string> = {
  new: 'bg-ok/15 text-ok',
  updated: 'bg-primary/15 text-primary',
  unchanged: 'bg-muted/15 text-muted',
};

function Field({ label, value, existing }: { label: string; value: string | null; existing: string | null }) {
  if (value == null && existing == null) return null;
  const changed = value != null && existing != null && value !== existing;
  return (
    <span className="mr-2">
      {label}:{' '}
      {changed ? (
        <span>
          <span className="line-through">{existing}</span> → <span className="font-semibold text-primary">{value}</span>
        </span>
      ) : (
        value ?? existing
      )}
    </span>
  );
}

/**
 * The inventory-domain twin of MenuImportPanel — same upload → draft →
 * review → approve flow, against apps/api's /api/ai/inventory-import*
 * routes (which share aiDocumentEngine.ts with menu import, see
 * apps/api/src/lib/inventoryImport.ts). The one property worth calling out
 * in the UI itself: an existing item's current stock is never touched by
 * this import — only cost/threshold/target can change, and only on
 * explicit approval — so "unchanged" rows have nothing left to approve.
 */
export function InventoryImportPanel({ slug, onClose }: { slug: string; onClose: () => void }) {
  const supabase = usePortalSupabase();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [stage, setStage] = useState<'idle' | 'uploading' | 'extracting' | 'review' | 'applying' | 'done'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [filename, setFilename] = useState('');
  const [draftId, setDraftId] = useState<string | null>(null);
  const [diff, setDiff] = useState<InventoryDiff | null>(null);
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
    const lower = file.name.toLowerCase();
    if (!lower.endsWith('.csv') && !lower.endsWith('.txt') && !lower.endsWith('.pdf')) {
      setError('Only CSV, plain text, or PDF files are supported right now.');
      return;
    }
    if (file.size > MAX_BYTES) {
      setError('File must be under 10 MB.');
      return;
    }
    setFilename(file.name);
    setStage('uploading');
    const path = `${Date.now()}-${file.name.replace(/[^a-zA-Z0-9_.-]/g, '_')}`;
    const { error: upErr } = await supabase.storage.from('ai-imports').upload(path, file, { contentType: file.type || 'text/plain' });
    if (upErr) {
      setError(upErr.message);
      setStage('idle');
      return;
    }
    setStage('extracting');
    try {
      const res = await fetch(`${API}/api/ai/inventory-import`, {
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
      // Default-approve every new or updated row — nothing to do for an
      // unchanged row, so it starts unchecked.
      const initial = new Set<string>();
      (body.diff as InventoryDiff).items.forEach((row, i) => {
        if (row.status !== 'unchanged') initial.add(String(i));
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
      const res = await fetch(`${API}/api/ai/inventory-import/apply`, {
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
    await fetch(`${API}/api/ai/inventory-import/reject`, {
      method: 'POST',
      headers: await authHeader(),
      body: JSON.stringify({ slug, draftId }),
    }).catch(() => {});
    onClose();
  }

  return (
    <div className="rounded-lg border border-primary/40 bg-primary/5 p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="font-bold text-sm">Import Inventory from File</h2>
        <button onClick={onClose} className="text-muted text-xs">
          ✕
        </button>
      </div>

      {error && <div className="rounded border border-danger/40 bg-danger/10 text-danger p-2.5 text-xs">{error}</div>}

      {stage === 'idle' && (
        <div>
          <p className="text-xs text-muted mb-2">
            Upload a CSV, text, or PDF inventory list. New ingredients can be created with an opening stock count;
            for ingredients you already stock, only cost, low-stock threshold, and target stock can be updated —
            <strong> current stock on hand is never changed by an import</strong>. Nothing is applied until you approve it.
          </p>
          <input
            ref={fileInputRef}
            type="file"
            accept=".csv,.txt,text/csv,text/plain,application/pdf"
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
            Choose File…
          </button>
        </div>
      )}

      {(stage === 'uploading' || stage === 'extracting') && (
        <p className="text-xs text-muted">
          {stage === 'uploading' ? `Uploading ${filename}…` : 'Reading the document and extracting the inventory list…'}
        </p>
      )}

      {(stage === 'review' || stage === 'applying') && diff && (
        <div className="space-y-3">
          <div className="text-xs">
            Found <strong>{diff.summary.items}</strong> rows —{' '}
            <span className="text-ok font-semibold">{diff.summary.new_items} new</span>,{' '}
            <span className="text-primary font-semibold">{diff.summary.updated_items} updated</span>.
          </div>
          {issues.length > 0 && (
            <div className="rounded border border-danger/40 bg-danger/10 p-2 text-[11px] text-danger space-y-0.5">
              <div className="font-bold">Action required</div>
              {issues.map((iss, i) => (
                <div key={i}>{iss.message}</div>
              ))}
            </div>
          )}
          <div className="max-h-96 overflow-y-auto space-y-1 border border-border rounded p-2 bg-surface">
            {diff.items.map((row, i) => {
              const key = String(i);
              const costStr = row.cost_cents_per_unit != null ? formatCents(row.cost_cents_per_unit) : null;
              const existingCostStr = row.existing_cost_cents_per_unit != null ? formatCents(row.existing_cost_cents_per_unit) : null;
              return (
                <label key={i} className="flex items-start gap-2 text-xs py-1 border-b border-border/40 last:border-0">
                  <input
                    type="checkbox"
                    className="mt-0.5"
                    checked={approved.has(key)}
                    disabled={row.status === 'unchanged' || stage === 'applying'}
                    onChange={() => toggle(key)}
                  />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <span className="font-semibold">{row.name}</span>
                      <span className={`text-[10px] font-bold uppercase px-1.5 py-0.5 rounded ${STATUS_STYLE[row.status]}`}>{row.status}</span>
                    </div>
                    <div className="text-[11px] text-muted">
                      {row.status === 'new' ? (
                        <>
                          {row.unit && <span className="mr-2">unit: {row.unit}</span>}
                          {row.opening_stock != null && <span className="mr-2">opening stock: {row.opening_stock}</span>}
                          {costStr && <span className="mr-2">cost/unit: {costStr}</span>}
                          {row.min_threshold != null && <span className="mr-2">min threshold: {row.min_threshold}</span>}
                          {row.target_stock != null && <span className="mr-2">target stock: {row.target_stock}</span>}
                        </>
                      ) : (
                        <>
                          <Field label="cost/unit" value={costStr} existing={existingCostStr} />
                          <Field label="min threshold" value={row.min_threshold?.toString() ?? null} existing={row.existing_min_threshold?.toString() ?? null} />
                          <Field label="target stock" value={row.target_stock?.toString() ?? null} existing={row.existing_target_stock?.toString() ?? null} />
                        </>
                      )}
                    </div>
                  </div>
                </label>
              );
            })}
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
          <p className="text-ok font-semibold">Inventory import applied.</p>
          <ul className="list-disc pl-4 text-muted">
            <li>{applyResult.items_created} item(s) created</li>
            <li>{applyResult.items_updated} item(s) updated</li>
          </ul>
          {applyResult.skipped.length > 0 && <div className="text-muted">Skipped: {applyResult.skipped.join(', ')}</div>}
          <button onClick={onClose} className="rounded border border-border px-3 py-1.5 text-xs font-semibold mt-1">
            Close
          </button>
        </div>
      )}
    </div>
  );
}
