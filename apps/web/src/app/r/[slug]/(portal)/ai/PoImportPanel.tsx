'use client';

import { useEffect, useRef, useState } from 'react';
import { usePortalSupabase } from '@/components/PortalProvider';
import { formatCents } from '@/lib/format';

const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';
const MAX_BYTES = 10 * 1024 * 1024;

type DiffPOLine = { item_name: string; qty: number | null; inventory_item_name: string | null; unit_label: string | null; unit_cost_cents: number | null; line_total_cents: number | null; issue: string | null };
type DiffPO = {
  supplier_name: string;
  notes: string | null;
  matched_supplier_name: string | null;
  lines: DiffPOLine[];
  subtotal_cents: number;
  status: 'ready' | 'blocked';
  issues: string[];
};
type POImportDiff = { summary: { orders: number; ready: number; blocked: number }; orders: DiffPO[] };
type ApplyResult = { orders_created: number; skipped: string[] };

const STATUS_STYLE: Record<string, string> = { ready: 'bg-ok/15 text-ok', blocked: 'bg-danger/15 text-danger' };

/** The PO-domain twin of the other AI import panels. Every created order
 *  lands as a DRAFT purchase order — nothing is approved or sent here,
 *  that stays a separate, human-only step in Purchasing. A line's price
 *  always comes from the supplier's own catalog, never invented; if any
 *  line in an order can't be priced, the whole order is blocked. */
export function PoImportPanel({
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
  const [diff, setDiff] = useState<POImportDiff | null>(null);
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
      const res = await fetch(`${API}/api/ai/po-import`, {
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
      (body.diff as POImportDiff).orders.forEach((row, i) => {
        if (row.status === 'ready') initial.add(String(i));
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
      const res = await fetch(`${API}/api/ai/po-import/apply`, {
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
    await fetch(`${API}/api/ai/po-import/reject`, {
      method: 'POST',
      headers: await authHeader(),
      body: JSON.stringify({ slug, draftId }),
    }).catch(() => {});
    onClose();
  }

  return (
    <div className="rounded-lg border border-primary/40 bg-primary/5 p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="font-bold text-sm">Import Purchase Orders from File</h2>
        <button onClick={onClose} className="text-muted text-xs">
          ✕
        </button>
      </div>

      {error && <div className="rounded border border-danger/40 bg-danger/10 text-danger p-2.5 text-xs">{error}</div>}

      {stage === 'idle' && (
        <div>
          <p className="text-xs text-muted mb-2">
            Upload a document listing one or more orders (supplier + items + quantities). Every created order is a{' '}
            <strong>draft</strong> — a manager must still approve and send it in Purchasing. Prices always come from
            the supplier&apos;s own catalog; an order with any unpriced item is blocked, not partially created.
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
        <p className="text-xs text-muted">{stage === 'uploading' ? `Uploading ${filename}…` : 'Reading the document and extracting orders…'}</p>
      )}

      {(stage === 'review' || stage === 'applying') && diff && (
        <div className="space-y-3">
          <div className="text-xs">
            Found <strong>{diff.summary.orders}</strong> order(s) —{' '}
            <span className="text-ok font-semibold">{diff.summary.ready} ready</span>
            {diff.summary.blocked > 0 && <span className="text-danger font-semibold">, {diff.summary.blocked} blocked</span>}.
          </div>
          <div className="max-h-96 overflow-y-auto space-y-2 border border-border rounded p-2 bg-surface">
            {diff.orders.map((po, i) => {
              const key = String(i);
              return (
                <label key={i} className="flex items-start gap-2 text-xs py-1.5 border-b border-border/40 last:border-0">
                  <input
                    type="checkbox"
                    className="mt-0.5"
                    checked={approved.has(key)}
                    disabled={po.status !== 'ready' || stage === 'applying'}
                    onChange={() => toggle(key)}
                  />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <span className="font-semibold">{po.matched_supplier_name ?? po.supplier_name}</span>
                      <span className={`text-[10px] font-bold uppercase px-1.5 py-0.5 rounded ${STATUS_STYLE[po.status]}`}>{po.status}</span>
                      {po.status === 'ready' && <span className="text-muted">subtotal {formatCents(po.subtotal_cents)}</span>}
                    </div>
                    <div className="text-[11px] text-muted">
                      {po.lines.map((l, li) => (
                        <span key={li} className={`mr-2 ${l.issue ? 'text-danger' : ''}`}>
                          {l.qty}× {l.inventory_item_name ?? l.item_name}
                          {l.unit_cost_cents != null ? ` @ ${formatCents(l.unit_cost_cents)}${l.unit_label ? `/${l.unit_label}` : ''}` : ''}
                          {l.issue ? ` (${l.issue})` : ''}
                        </span>
                      ))}
                    </div>
                    {po.status === 'blocked' && po.issues.length > 0 && <div className="text-[11px] text-danger">{po.issues.join(' · ')}</div>}
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
              {stage === 'applying' ? 'Creating…' : `Create ${approved.size} Draft Order(s)`}
            </button>
            <button onClick={reject} disabled={stage === 'applying'} className="rounded border border-danger text-danger px-3 py-1.5 text-xs font-semibold">
              Reject All
            </button>
          </div>
        </div>
      )}

      {stage === 'done' && applyResult && (
        <div className="space-y-2 text-xs">
          <p className="text-ok font-semibold">{applyResult.orders_created} draft order(s) created.</p>
          <p className="text-muted">Review and approve/send them from Purchasing when ready.</p>
          {applyResult.skipped.length > 0 && <div className="text-muted">Skipped: {applyResult.skipped.join(', ')}</div>}
          <button onClick={onClose} className="rounded border border-border px-3 py-1.5 text-xs font-semibold mt-1">
            Close
          </button>
        </div>
      )}
    </div>
  );
}
