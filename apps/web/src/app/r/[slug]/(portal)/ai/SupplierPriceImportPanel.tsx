'use client';

import { useEffect, useRef, useState } from 'react';
import { usePortalSupabase } from '@/components/PortalProvider';
import { formatCents } from '@/lib/format';

const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';
const MAX_BYTES = 10 * 1024 * 1024;

type DiffPriceRow = {
  supplier_name: string;
  item_name: string;
  matched_supplier_name: string | null;
  matched_inventory_item_name: string | null;
  price_cents: number | null;
  existing_price_cents: number | null;
  purchase_unit_label: string | null;
  moq: number | null;
  lead_time_days: number | null;
  status: 'new' | 'updated' | 'unchanged' | 'blocked';
  issues: string[];
};
type SupplierPriceImportDiff = { summary: { rows: number; new_rows: number; updated_rows: number; blocked: number }; rows: DiffPriceRow[] };
type ApplyResult = { catalog_entries_created: number; prices_updated: number; skipped: string[] };

const STATUS_STYLE: Record<string, string> = {
  new: 'bg-ok/15 text-ok',
  updated: 'bg-primary/15 text-primary',
  unchanged: 'bg-muted/15 text-muted',
  blocked: 'bg-danger/15 text-danger',
};

/** The supplier-price-domain twin of the other AI import panels. Writes
 *  to a supplier's OWN catalog (supplier_items), never the restaurant's
 *  general inventory cost — a price CHANGE goes through
 *  set_supplier_item_price() at apply time, logged like every other
 *  price change. */
export function SupplierPriceImportPanel({
  slug,
  onClose,
  initialFile,
}: {
  slug: string;
  onClose: () => void;
  initialFile?: File;
}) {
  const supabase = usePortalSupabase();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const ranInitialFile = useRef(false);
  const [stage, setStage] = useState<'idle' | 'uploading' | 'extracting' | 'review' | 'applying' | 'done'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [filename, setFilename] = useState('');
  const [draftId, setDraftId] = useState<string | null>(null);
  const [diff, setDiff] = useState<SupplierPriceImportDiff | null>(null);
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
      const res = await fetch(`${API}/api/ai/supplier-price-import`, {
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
      const initial = new Set<string>();
      (body.diff as SupplierPriceImportDiff).rows.forEach((row, i) => {
        if (row.status === 'new' || row.status === 'updated') initial.add(String(i));
      });
      setApproved(initial);
      setStage('review');
    } catch {
      setError('Network error.');
      setStage('idle');
    }
  }

  useEffect(() => {
    if (initialFile && !ranInitialFile.current) {
      ranInitialFile.current = true;
      handleFile(initialFile);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
      const res = await fetch(`${API}/api/ai/supplier-price-import/apply`, {
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
    await fetch(`${API}/api/ai/supplier-price-import/reject`, {
      method: 'POST',
      headers: await authHeader(),
      body: JSON.stringify({ slug, draftId }),
    }).catch(() => {});
    onClose();
  }

  return (
    <div className="rounded-lg border border-primary/40 bg-primary/5 p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="font-bold text-sm">Import Supplier Prices from File</h2>
        <button onClick={onClose} className="text-muted text-xs">
          ✕
        </button>
      </div>

      {error && <div className="rounded border border-danger/40 bg-danger/10 text-danger p-2.5 text-xs">{error}</div>}

      {stage === 'idle' && (
        <div>
          <p className="text-xs text-muted mb-2">
            Upload a supplier&apos;s price list (CSV, text, or PDF). Matches each row to an existing supplier and
            inventory item — both must already exist. A price change is logged like any other price change.
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
          <button onClick={() => fileInputRef.current?.click()} className="rounded bg-primary text-primary-fg font-bold px-3 py-1.5 text-xs">
            Choose File…
          </button>
        </div>
      )}

      {(stage === 'uploading' || stage === 'extracting') && (
        <p className="text-xs text-muted">{stage === 'uploading' ? `Uploading ${filename}…` : 'Reading the document and extracting prices…'}</p>
      )}

      {(stage === 'review' || stage === 'applying') && diff && (
        <div className="space-y-3">
          <div className="text-xs">
            Found <strong>{diff.summary.rows}</strong> row(s) —{' '}
            <span className="text-ok font-semibold">{diff.summary.new_rows} new</span>,{' '}
            <span className="text-primary font-semibold">{diff.summary.updated_rows} updated</span>
            {diff.summary.blocked > 0 && <span className="text-danger font-semibold">, {diff.summary.blocked} blocked</span>}.
          </div>
          <div className="max-h-96 overflow-y-auto space-y-1 border border-border rounded p-2 bg-surface">
            {diff.rows.map((row, i) => {
              const key = String(i);
              return (
                <label key={i} className="flex items-start gap-2 text-xs py-1.5 border-b border-border/40 last:border-0">
                  <input
                    type="checkbox"
                    className="mt-0.5"
                    checked={approved.has(key)}
                    disabled={row.status === 'unchanged' || row.status === 'blocked' || stage === 'applying'}
                    onChange={() => toggle(key)}
                  />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <span className="font-semibold">{row.matched_inventory_item_name ?? row.item_name}</span>
                      <span className="text-muted">from {row.matched_supplier_name ?? row.supplier_name}</span>
                      <span className={`text-[10px] font-bold uppercase px-1.5 py-0.5 rounded ${STATUS_STYLE[row.status]}`}>{row.status}</span>
                    </div>
                    <div className="text-[11px] text-muted">
                      {row.price_cents != null && (
                        <span className="mr-2">
                          {row.existing_price_cents != null && row.existing_price_cents !== row.price_cents ? (
                            <>
                              <span className="line-through">{formatCents(row.existing_price_cents)}</span> →{' '}
                              <span className="font-semibold text-primary">{formatCents(row.price_cents)}</span>
                            </>
                          ) : (
                            formatCents(row.price_cents)
                          )}
                          {row.purchase_unit_label ? ` / ${row.purchase_unit_label}` : ''}
                        </span>
                      )}
                      {row.moq != null && <span className="mr-2">MOQ {row.moq}</span>}
                      {row.lead_time_days != null && <span className="mr-2">{row.lead_time_days}d lead time</span>}
                    </div>
                    {row.issues.length > 0 && <div className="text-[11px] text-danger">{row.issues.join(' · ')}</div>}
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
              {stage === 'applying' ? 'Applying…' : `Apply ${approved.size} Selected`}
            </button>
            <button onClick={reject} disabled={stage === 'applying'} className="rounded border border-danger text-danger px-3 py-1.5 text-xs font-semibold">
              Reject All
            </button>
          </div>
        </div>
      )}

      {stage === 'done' && applyResult && (
        <div className="space-y-2 text-xs">
          <p className="text-ok font-semibold">Supplier price import applied.</p>
          <ul className="list-disc pl-4 text-muted">
            <li>{applyResult.catalog_entries_created} new catalog entr{applyResult.catalog_entries_created === 1 ? 'y' : 'ies'} created</li>
            <li>{applyResult.prices_updated} price(s) updated</li>
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
