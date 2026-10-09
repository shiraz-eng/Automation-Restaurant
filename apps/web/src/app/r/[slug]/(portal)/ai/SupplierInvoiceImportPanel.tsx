'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { usePortalSupabase } from '@/components/PortalProvider';
import { formatCents } from '@/lib/format';

const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';
const MAX_BYTES = 10 * 1024 * 1024;
const ACCEPT = '.pdf,.jpg,.jpeg,.png,.webp,.txt,.csv';

type DraftLine = {
  description: string;
  unit: string | null;
  qty: number | null;
  unit_cost_cents: number | null;
  line_total_cents: number | null;
  po_line_id: string | null;
  notes: string[];
};
type Draft = {
  supplier_name_on_document: string | null;
  supplier_id: string | null;
  supplier_invoice_number: string | null;
  invoice_date: string | null;
  due_date: string | null;
  purchase_order_id: string | null;
  po_reference_on_document: string | null;
  tax_cents: number;
  delivery_cents: number;
  discount_cents: number;
  total_cents: number | null;
  lines: DraftLine[];
  warnings: string[];
  blockers: string[];
  status: 'ready' | 'needs_review' | 'blocked';
};
type EditLine = { description: string; qty: string; price: string; po_line_id: string; notes: string[] };
type POOption = {
  id: string;
  po_number: number;
  purchase_order_lines: { id: string; description: string; qty: number; received_qty: number; rejected_qty: number; unit_cost_cents: number }[];
};

const money = (c: number | null | undefined) => (c == null ? '' : (c / 100).toFixed(2));
const toCents = (s: string) => Math.max(0, Math.round((parseFloat(s) || 0) * 100));

/** Read a supplier's invoice with AI, then a PERSON checks and corrects
 *  every field before the invoice is created. The created invoice is only
 *  'received' — it still goes through the 3-way match and approval like any
 *  other invoice; nothing here approves or pays. */
export function SupplierInvoiceImportPanel({
  slug,
  onClose,
  initialFile,
  canMatch = false,
}: {
  slug: string;
  onClose: () => void;
  initialFile?: File;
  /** invoices.match — offer "Run 3-way match now" after saving. */
  canMatch?: boolean;
}) {
  const supabase = usePortalSupabase();
  const router = useRouter();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const ranInitial = useRef(false);
  const [stage, setStage] = useState<'idle' | 'uploading' | 'reading' | 'review' | 'saving' | 'done'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [filename, setFilename] = useState('');
  const [draftId, setDraftId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);

  const [suppliers, setSuppliers] = useState<{ id: string; name: string }[]>([]);
  const [pos, setPos] = useState<POOption[]>([]);
  const [supplierId, setSupplierId] = useState('');
  const [poId, setPoId] = useState('');
  const [number, setNumber] = useState('');
  const [invoiceDate, setInvoiceDate] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [tax, setTax] = useState('');
  const [delivery, setDelivery] = useState('');
  const [discount, setDiscount] = useState('');
  const [lines, setLines] = useState<EditLine[]>([]);

  const [created, setCreated] = useState<{ id: string; totalCents: number } | null>(null);
  const [matchResult, setMatchResult] = useState<{ matched: boolean; holds: { kind: string; reason: string }[] } | null>(null);

  async function authHeader() {
    const {
      data: { session },
    } = await supabase.auth.getSession();
    return { 'Content-Type': 'application/json', Authorization: `Bearer ${session?.access_token ?? ''}` };
  }

  async function post(path: string, body: object) {
    const res = await fetch(`${API}/api/ai/${path}`, { method: 'POST', headers: await authHeader(), body: JSON.stringify({ slug, ...body }) });
    const json = await res.json().catch(() => ({
      message: res.status === 504 ? 'Reading the invoice took too long — try a clearer or smaller file.' : `The import service returned HTTP ${res.status}.`,
    }));
    return { ok: res.ok, json };
  }

  async function handleFile(file: File) {
    setError(null);
    const ext = file.name.toLowerCase().split('.').pop() ?? '';
    if (!['pdf', 'jpg', 'jpeg', 'png', 'webp', 'txt', 'csv'].includes(ext)) {
      setError('Upload the invoice as a PDF, a photo (JPG, PNG, WebP) or a text file.');
      return;
    }
    if (file.size > MAX_BYTES) {
      setError('File must be under 10 MB.');
      return;
    }
    setFilename(file.name);
    setStage('uploading');
    const path = `${Date.now()}-invoice-${file.name.replace(/[^a-zA-Z0-9_.-]/g, '_')}`;
    const { error: upErr } = await supabase.storage.from('ai-imports').upload(path, file, { contentType: file.type || 'application/octet-stream' });
    if (upErr) {
      setError(upErr.message);
      setStage('idle');
      return;
    }
    setStage('reading');
    try {
      const { ok, json } = await post('supplier-invoice-import', { storagePath: path, filename: file.name });
      if (!ok) {
        setError(json.message ?? json.error ?? 'Could not read this invoice.');
        setStage('idle');
        return;
      }
      const d = json.draft as Draft;
      setDraftId(json.draftId);
      setDraft(d);
      setSupplierId(d.supplier_id ?? '');
      setPoId(d.purchase_order_id ?? '');
      setNumber(d.supplier_invoice_number ?? '');
      setInvoiceDate(d.invoice_date ?? new Date().toISOString().slice(0, 10));
      setDueDate(d.due_date ?? '');
      setTax(money(d.tax_cents));
      setDelivery(money(d.delivery_cents));
      setDiscount(money(d.discount_cents));
      setLines(
        d.lines.map((l) => ({
          description: l.description,
          qty: l.qty == null ? '' : String(l.qty),
          price: money(l.unit_cost_cents),
          po_line_id: l.po_line_id ?? '',
          notes: l.notes,
        })),
      );
      setStage('review');
    } catch {
      setError('Network error.');
      setStage('idle');
    }
  }

  useEffect(() => {
    if (initialFile && !ranInitial.current) {
      ranInitial.current = true;
      void handleFile(initialFile);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (stage !== 'review') return;
    void supabase
      .from('suppliers')
      .select('id, name')
      .eq('is_active', true)
      .order('name')
      .then(({ data }) => setSuppliers((data as { id: string; name: string }[]) ?? []));
  }, [stage, supabase]);

  useEffect(() => {
    if (!supplierId) {
      setPos([]);
      return;
    }
    void supabase
      .from('purchase_orders')
      .select('id, po_number, purchase_order_lines(id, description, qty, received_qty, rejected_qty, unit_cost_cents)')
      .eq('supplier_id', supplierId)
      .in('status', ['sent', 'partial', 'received'])
      .order('created_at', { ascending: false })
      .limit(50)
      .then(({ data }) => setPos((data as unknown as POOption[]) ?? []));
  }, [supplierId, supabase]);

  const poLines = useMemo(() => pos.find((p) => p.id === poId)?.purchase_order_lines ?? [], [pos, poId]);
  const subtotal = lines.reduce((s, l) => s + Math.round((parseFloat(l.qty) || 0) * toCents(l.price)), 0);
  const total = Math.max(0, subtotal + toCents(tax) + toCents(delivery) - toCents(discount));
  const printedDiffers = draft?.total_cents != null && Math.abs(draft.total_cents - total) > 1;

  const problems = [
    !supplierId && 'Choose the supplier.',
    !number.trim() && "Enter the supplier's invoice number.",
    !/^\d{4}-\d{2}-\d{2}$/.test(invoiceDate) && 'Enter the invoice date.',
    lines.length === 0 && 'Add at least one line.',
    lines.some((l) => !l.description.trim() || !(parseFloat(l.qty) > 0)) && 'Every line needs a description and a quantity.',
  ].filter(Boolean) as string[];

  function setLine(i: number, patch: Partial<EditLine>) {
    setLines((ls) => ls.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));
  }

  async function create() {
    if (!draftId || problems.length) return;
    setStage('saving');
    setError(null);
    const { ok, json } = await post('supplier-invoice-import/apply', {
      draftId,
      invoice: {
        supplier_id: supplierId,
        purchase_order_id: poId || null,
        supplier_invoice_number: number.trim(),
        invoice_date: invoiceDate,
        due_date: dueDate || null,
        tax_cents: toCents(tax),
        delivery_cents: toCents(delivery),
        discount_cents: toCents(discount),
        notes: null,
      },
      lines: lines.map((l) => ({
        description: l.description.trim(),
        qty: parseFloat(l.qty),
        unit_cost_cents: toCents(l.price),
        po_line_id: l.po_line_id || null,
      })),
    });
    if (!ok) {
      setError(json.message ?? json.error ?? 'Could not create the invoice.');
      setStage('review');
      return;
    }
    setCreated({ id: json.invoiceId, totalCents: json.totalCents });
    setStage('done');
    router.refresh();
  }

  async function discard() {
    if (draftId) await post('supplier-invoice-import/reject', { draftId }).catch(() => undefined);
    onClose();
  }

  async function runMatch() {
    if (!created) return;
    setError(null);
    const { data, error: e } = await supabase.rpc('match_supplier_invoice', { p_invoice_id: created.id });
    if (e) setError(e.message);
    else setMatchResult(data as { matched: boolean; holds: { kind: string; reason: string }[] });
    router.refresh();
  }

  return (
    <div className="rounded-lg border border-primary/40 bg-primary/5 p-4 space-y-3 text-xs">
      <div className="flex items-center justify-between">
        <h2 className="font-bold text-sm">Read a supplier invoice with AI</h2>
        <button onClick={stage === 'review' ? discard : onClose} className="text-muted text-xs">
          ✕
        </button>
      </div>
      {error && <p className="rounded border border-danger/40 bg-danger/10 px-3 py-2 text-danger">{error}</p>}

      {stage === 'idle' && (
        <>
          <p className="text-muted">
            Upload the supplier&apos;s invoice — a PDF, a phone photo or a scan. The assistant fills in a draft; you check every
            field before anything is saved. Nothing is approved or paid.
          </p>
          <input
            ref={fileInputRef}
            type="file"
            accept={ACCEPT}
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void handleFile(f);
            }}
          />
          <button onClick={() => fileInputRef.current?.click()} className="rounded bg-primary text-primary-fg font-semibold px-3 py-2">
            Choose invoice file
          </button>
        </>
      )}
      {(stage === 'uploading' || stage === 'reading') && (
        <p className="text-muted">{stage === 'uploading' ? `Uploading ${filename}…` : `Reading ${filename}… this can take up to a minute.`}</p>
      )}

      {stage === 'review' && draft && (
        <div className="space-y-3">
          <p className="text-muted">
            From <span className="font-semibold text-body">{filename}</span>
            {draft.supplier_name_on_document ? ` · issued by "${draft.supplier_name_on_document}"` : ''}
            {draft.po_reference_on_document ? ` · quotes PO "${draft.po_reference_on_document}"` : ''}. Check everything below.
          </p>
          {[...draft.blockers, ...draft.warnings].length > 0 && (
            <ul className="space-y-1">
              {draft.blockers.map((b) => (
                <li key={b} className="text-danger">
                  ● {b}
                </li>
              ))}
              {draft.warnings.map((w) => (
                <li key={w} className="text-warn">
                  ● {w}
                </li>
              ))}
            </ul>
          )}

          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
            <Labeled label="Supplier">
              <select value={supplierId} onChange={(e) => { setSupplierId(e.target.value); setPoId(''); setLines((ls) => ls.map((l) => ({ ...l, po_line_id: '' }))); }} className={field}>
                <option value="">Choose…</option>
                {suppliers.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </Labeled>
            <Labeled label="Purchase order">
              <select value={poId} onChange={(e) => { setPoId(e.target.value); setLines((ls) => ls.map((l) => ({ ...l, po_line_id: '' }))); }} className={field} disabled={!supplierId}>
                <option value="">No PO</option>
                {pos.map((p) => (
                  <option key={p.id} value={p.id}>
                    PO #{p.po_number}
                  </option>
                ))}
              </select>
            </Labeled>
            <Labeled label="Supplier's invoice #">
              <input value={number} onChange={(e) => setNumber(e.target.value)} className={field} />
            </Labeled>
            <Labeled label="Invoice date">
              <input type="date" value={invoiceDate} onChange={(e) => setInvoiceDate(e.target.value)} className={field} />
            </Labeled>
            <Labeled label="Due date (blank = supplier terms)">
              <input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} className={field} />
            </Labeled>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left">
              <thead className="text-muted">
                <tr>
                  <th className="py-1 pr-2 font-semibold">Item</th>
                  <th className="py-1 pr-2 font-semibold w-20">Qty</th>
                  <th className="py-1 pr-2 font-semibold w-24">Unit price</th>
                  <th className="py-1 pr-2 font-semibold">PO line</th>
                  <th className="py-1 font-semibold text-right">Amount</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {lines.map((l, i) => (
                  <tr key={i} className="align-top">
                    <td className="py-1 pr-2">
                      <input value={l.description} onChange={(e) => setLine(i, { description: e.target.value })} className={field} />
                      {l.notes.map((n) => (
                        <p key={n} className="text-[10px] text-warn mt-0.5">
                          {n}
                        </p>
                      ))}
                    </td>
                    <td className="py-1 pr-2">
                      <input type="number" min="0" step="0.001" value={l.qty} onChange={(e) => setLine(i, { qty: e.target.value })} className={field} />
                    </td>
                    <td className="py-1 pr-2">
                      <input type="number" min="0" step="0.01" value={l.price} onChange={(e) => setLine(i, { price: e.target.value })} className={field} />
                    </td>
                    <td className="py-1 pr-2">
                      <select value={l.po_line_id} onChange={(e) => setLine(i, { po_line_id: e.target.value })} className={field} disabled={!poId}>
                        <option value="">Not linked</option>
                        {poLines.map((pl) => (
                          <option key={pl.id} value={pl.id}>
                            {pl.description} · ordered {Number(pl.qty)}, accepted {Number(pl.received_qty) - Number(pl.rejected_qty)} @{' '}
                            {(pl.unit_cost_cents / 100).toFixed(2)}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className="py-1 text-right font-mono whitespace-nowrap">
                      {formatCents(Math.round((parseFloat(l.qty) || 0) * toCents(l.price)))}
                    </td>
                    <td className="py-1 pl-2">
                      <button onClick={() => setLines((ls) => ls.filter((_, idx) => idx !== i))} className="text-muted" aria-label="Remove line">
                        ✕
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <button
              onClick={() => setLines((ls) => [...ls, { description: '', qty: '', price: '', po_line_id: '', notes: [] }])}
              className="mt-1 text-primary font-semibold"
            >
              + line
            </button>
          </div>

          <div className="grid grid-cols-3 gap-2 max-w-md">
            <Labeled label="Tax">
              <input type="number" min="0" step="0.01" value={tax} onChange={(e) => setTax(e.target.value)} className={field} />
            </Labeled>
            <Labeled label="Delivery">
              <input type="number" min="0" step="0.01" value={delivery} onChange={(e) => setDelivery(e.target.value)} className={field} />
            </Labeled>
            <Labeled label="Discount">
              <input type="number" min="0" step="0.01" value={discount} onChange={(e) => setDiscount(e.target.value)} className={field} />
            </Labeled>
          </div>
          <p className="font-semibold">
            Subtotal {formatCents(subtotal)} · Total <span className="font-mono">{formatCents(total)}</span>
            {printedDiffers && (
              <span className="text-warn font-normal"> — the invoice prints {formatCents(draft.total_cents ?? 0)}; check the lines</span>
            )}
          </p>

          {problems.length > 0 && <p className="text-danger">{problems.join(' ')}</p>}
          <div className="flex flex-wrap gap-2">
            <button
              onClick={() => void create()}
              disabled={problems.length > 0}
              className="rounded bg-primary text-primary-fg font-semibold px-3 py-2 disabled:opacity-50"
            >
              Create invoice for matching
            </button>
            <button onClick={() => void discard()} className="rounded border border-border px-3 py-2">
              Discard draft
            </button>
          </div>
        </div>
      )}
      {stage === 'saving' && <p className="text-muted">Creating the invoice…</p>}

      {stage === 'done' && created && (
        <div className="space-y-2">
          <p className="text-ok font-semibold">
            Invoice created ({formatCents(created.totalCents)}) with the original file attached. It is waiting for the 3-way match —
            nothing has been approved or paid.
          </p>
          {matchResult && (
            <div className={matchResult.matched ? 'text-ok' : 'text-danger'}>
              {matchResult.matched ? 'Matched — ready for approval.' : 'On hold — exceptions found:'}
              {!matchResult.matched && (
                <ul className="mt-1 list-disc pl-4">
                  {matchResult.holds.map((h, i) => (
                    <li key={i}>{h.reason}</li>
                  ))}
                </ul>
              )}
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            {canMatch && !matchResult && (
              <button onClick={() => void runMatch()} className="rounded bg-primary text-primary-fg font-semibold px-3 py-2">
                Run 3-way match now
              </button>
            )}
            <a href={`/r/${slug}/purchasing`} className="rounded border border-border px-3 py-2">
              Open Purchasing
            </a>
            <button onClick={onClose} className="rounded border border-border px-3 py-2">
              Close
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

const field = 'w-full rounded border border-border bg-surface px-2 py-1.5 text-xs';

function Labeled({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="text-muted text-[10px] font-semibold">{label}</span>
      <div className="mt-0.5">{children}</div>
    </label>
  );
}
