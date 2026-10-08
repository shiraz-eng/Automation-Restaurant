'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { usePortalSupabase } from '@/components/PortalProvider';
import { Button } from '@/components/ui';
import { formatCents, formatDateTime } from '@/lib/format';

type Detail = {
  id: string;
  invoice_ref: number;
  supplier_invoice_number: string;
  invoice_date: string;
  due_date: string | null;
  status: string;
  subtotal_cents: number;
  tax_cents: number;
  discount_cents: number;
  delivery_fee_cents: number;
  total_cents: number;
  notes: string | null;
  attachment_path: string | null;
  rejection_reason: string | null;
  match_result: { expected_total_cents?: number; qty_tolerance_pct?: number; price_tolerance_pct?: number } | null;
  suppliers: { name: string } | { name: string }[] | null;
  purchase_orders: { po_number: number } | { po_number: number }[] | null;
};
type Line = {
  id: string;
  description: string;
  qty: number;
  unit_cost_cents: number;
  line_total_cents: number;
  po_line_id: string | null;
  purchase_order_lines:
    | { qty: number; received_qty: number; rejected_qty: number; unit_cost_cents: number }
    | { qty: number; received_qty: number; rejected_qty: number; unit_cost_cents: number }[]
    | null;
};
type HoldRow = { id: string; kind: string; reason: string; amount_cents: number; status: string; resolution_note: string | null };
type HistoryRow = { at: string; kind: string; actor: string; amount_cents: number | null; detail: string | null };

const one = <T,>(v: T | T[] | null): T | null => (Array.isArray(v) ? (v[0] ?? null) : v);

const HOLD_LABEL: Record<string, string> = {
  quantity: 'Quantity',
  price: 'Price',
  total: 'Total',
  missing_po: 'No PO',
  missing_grn: 'Not received',
  supplier: 'Wrong supplier',
  po_mismatch: 'Other PO',
  duplicate: 'Already billed',
  other: 'Check',
};
const HISTORY_LABEL: Record<string, string> = {
  created: 'Recorded',
  matched: 'Matched',
  match_failed: 'Match found problems',
  hold: 'Exception',
  hold_resolved: 'Exception resolved',
  approved: 'Approved',
  rejected: 'Rejected',
  payment: 'Payment',
  credit_note: 'Credit note',
};

export function InvoiceDetail({
  invoiceId,
  canMatch,
  canApprove,
  canResolve,
  onClose,
}: {
  invoiceId: string;
  canMatch: boolean;
  /** invoices.approve / payables.manage — approve and reject. */
  canApprove: boolean;
  /** payables.manage — resolve exceptions. */
  canResolve: boolean;
  onClose: () => void;
}) {
  const supabase = usePortalSupabase();
  const router = useRouter();
  const [inv, setInv] = useState<Detail | null>(null);
  const [lines, setLines] = useState<Line[]>([]);
  const [holds, setHolds] = useState<HoldRow[]>([]);
  const [history, setHistory] = useState<HistoryRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const [invRes, linesRes, holdsRes, histRes] = await Promise.all([
      supabase
        .from('supplier_invoices')
        .select(
          'id, invoice_ref, supplier_invoice_number, invoice_date, due_date, status, subtotal_cents, tax_cents, discount_cents, delivery_fee_cents, total_cents, notes, attachment_path, rejection_reason, match_result, suppliers(name), purchase_orders(po_number)',
        )
        .eq('id', invoiceId)
        .single(),
      supabase
        .from('supplier_invoice_lines')
        .select('id, description, qty, unit_cost_cents, line_total_cents, po_line_id, purchase_order_lines(qty, received_qty, rejected_qty, unit_cost_cents)')
        .eq('invoice_id', invoiceId)
        .order('description'),
      supabase
        .from('supplier_payment_holds')
        .select('id, kind, reason, amount_cents, status, resolution_note')
        .eq('invoice_id', invoiceId)
        .order('created_at', { ascending: false }),
      supabase.rpc('supplier_invoice_history', { p_invoice_id: invoiceId }),
    ]);
    const err = invRes.error ?? linesRes.error ?? histRes.error;
    if (err) setError(err.message);
    setInv((invRes.data as unknown as Detail) ?? null);
    setLines((linesRes.data as unknown as Line[]) ?? []);
    setHolds(((holdsRes.data as HoldRow[] | null) ?? []).filter((h) => h.resolution_note !== 'superseded by re-match'));
    setHistory((histRes.data as HistoryRow[] | null) ?? []);
  }, [supabase, invoiceId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function act(fn: () => PromiseLike<{ error: { message: string } | null }>) {
    setBusy(true);
    setError(null);
    const { error: e } = await fn();
    setBusy(false);
    if (e) setError(e.message);
    else {
      await load();
      router.refresh();
    }
  }

  async function openAttachment(path: string) {
    const { data, error: e } = await supabase.storage.from('supplier-invoices').createSignedUrl(path, 300);
    if (e || !data) setError(e?.message ?? 'Could not open the attachment.');
    else window.open(data.signedUrl, '_blank', 'noopener');
  }

  if (!inv) {
    return <div className="mt-3 border-t border-border pt-3 text-xs text-muted">{error ?? 'Loading invoice…'}</div>;
  }

  const paid = history.filter((h) => h.kind === 'payment').reduce((s, h) => s + (h.amount_cents ?? 0), 0);
  const credited = history.filter((h) => h.kind === 'credit_note').reduce((s, h) => s + (h.amount_cents ?? 0), 0);
  const outstanding = inv.status === 'cancelled' ? 0 : Math.max(0, inv.total_cents - paid - credited);
  const openHolds = holds.filter((h) => h.status === 'open');
  const po = one(inv.purchase_orders);

  return (
    <div className="mt-3 border-t border-border pt-3 space-y-4 text-xs">
      {error && <p className="text-danger">{error}</p>}

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Info label="Supplier" value={one(inv.suppliers)?.name ?? '—'} />
        <Info label="Supplier's invoice #" value={inv.supplier_invoice_number} />
        <Info label="Our reference" value={`#${inv.invoice_ref}`} />
        <Info label="Purchase order" value={po ? `PO #${po.po_number}` : 'None'} />
        <Info label="Invoice date" value={inv.invoice_date} />
        <Info label="Due" value={inv.due_date ?? '—'} />
        <Info label="Paid / credited" value={`${formatCents(paid)} / ${formatCents(credited)}`} />
        <Info label="Outstanding" value={formatCents(outstanding)} strong />
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-left">
          <thead className="text-muted border-b border-border">
            <tr>
              <th className="py-1.5 pr-3 font-semibold">Line</th>
              <th className="py-1.5 pr-3 font-semibold text-right">Billed qty</th>
              <th className="py-1.5 pr-3 font-semibold text-right">Ordered / accepted</th>
              <th className="py-1.5 pr-3 font-semibold text-right">Billed price</th>
              <th className="py-1.5 pr-3 font-semibold text-right">PO price</th>
              <th className="py-1.5 font-semibold text-right">Line total</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((l) => {
              const pol = one(l.purchase_order_lines);
              const accepted = pol ? Number(pol.received_qty) - Number(pol.rejected_qty) : null;
              const qtyOff = accepted != null && Number(l.qty) !== accepted;
              const priceOff = pol != null && l.unit_cost_cents !== pol.unit_cost_cents;
              return (
                <tr key={l.id} className="border-b border-border/50 last:border-0">
                  <td className="py-1.5 pr-3">{l.description}</td>
                  <td className={`py-1.5 pr-3 text-right font-mono ${qtyOff ? 'text-danger font-bold' : ''}`}>{Number(l.qty)}</td>
                  <td className="py-1.5 pr-3 text-right font-mono text-muted">
                    {pol ? `${Number(pol.qty)} / ${accepted}` : 'no PO line'}
                  </td>
                  <td className={`py-1.5 pr-3 text-right font-mono ${priceOff ? 'text-danger font-bold' : ''}`}>
                    {formatCents(l.unit_cost_cents)}
                  </td>
                  <td className="py-1.5 pr-3 text-right font-mono text-muted">{pol ? formatCents(pol.unit_cost_cents) : '—'}</td>
                  <td className="py-1.5 text-right font-mono">{formatCents(l.line_total_cents)}</td>
                </tr>
              );
            })}
          </tbody>
          <tfoot className="text-muted">
            <Row label="Subtotal" cents={inv.subtotal_cents} />
            {inv.tax_cents > 0 && <Row label="Tax" cents={inv.tax_cents} />}
            {inv.delivery_fee_cents > 0 && <Row label="Delivery" cents={inv.delivery_fee_cents} />}
            {inv.discount_cents > 0 && <Row label="Discount" cents={-inv.discount_cents} />}
            <tr>
              <td colSpan={5} className="pt-1 text-right font-bold text-body">Invoice total</td>
              <td className="pt-1 text-right font-mono font-bold text-body">{formatCents(inv.total_cents)}</td>
            </tr>
          </tfoot>
        </table>
      </div>

      {inv.status === 'cancelled' && inv.rejection_reason && (
        <p className="rounded border border-danger/40 bg-danger/10 px-3 py-2 text-danger">Rejected: {inv.rejection_reason}</p>
      )}

      {holds.length > 0 && (
        <div className="space-y-1.5">
          <p className="font-bold">Match exceptions</p>
          {holds.map((h) => (
            <div
              key={h.id}
              className={`flex items-start justify-between gap-3 rounded border px-3 py-2 ${
                h.status === 'open' ? 'border-danger/40 bg-danger/5' : 'border-border text-muted'
              }`}
            >
              <div>
                <span className="mr-2 rounded bg-main px-1.5 py-0.5 text-[10px] font-bold uppercase">{HOLD_LABEL[h.kind] ?? h.kind}</span>
                {h.reason}
                {h.status === 'resolved' && h.resolution_note && <span className="ml-1">— resolved: {h.resolution_note}</span>}
              </div>
              {h.status === 'open' && canResolve && (
                <Button
                  variant="ghost"
                  disabled={busy}
                  onClick={() => {
                    const note = window.prompt('How was this resolved? (e.g. "Supplier confirmed price increase")');
                    if (note && note.trim())
                      void act(() => supabase.rpc('resolve_payment_hold', { p_hold_id: h.id, p_resolution_note: note.trim() }));
                  }}
                >
                  Resolve
                </Button>
              )}
            </div>
          ))}
        </div>
      )}

      {history.length > 0 && (
        <div>
          <p className="font-bold mb-1.5">History</p>
          <ol className="space-y-1">
            {history.map((h, i) => (
              <li key={i} className="flex flex-wrap gap-x-2">
                <span className="text-muted font-mono">{formatDateTime(h.at)}</span>
                <span className="font-semibold">{HISTORY_LABEL[h.kind] ?? h.kind}</span>
                {h.amount_cents != null && h.kind !== 'created' && <span className="font-mono">{formatCents(h.amount_cents)}</span>}
                {h.detail && <span className="text-muted">{h.detail}</span>}
                <span className="text-muted">· {h.actor}</span>
              </li>
            ))}
          </ol>
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        {inv.attachment_path && (
          <Button variant="ghost" onClick={() => void openAttachment(inv.attachment_path!)}>
            View attached invoice
          </Button>
        )}
        {canMatch && ['received', 'on_hold', 'matched'].includes(inv.status) && (
          <Button variant="ghost" disabled={busy} onClick={() => void act(() => supabase.rpc('match_supplier_invoice', { p_invoice_id: inv.id }))}>
            {inv.status === 'received' ? 'Run 3-way match' : 'Re-run match'}
          </Button>
        )}
        {canApprove && inv.status === 'matched' && openHolds.length === 0 && (
          <Button disabled={busy} onClick={() => void act(() => supabase.rpc('approve_supplier_invoice', { p_invoice_id: inv.id }))}>
            Approve for payment
          </Button>
        )}
        {canApprove && ['received', 'on_hold', 'matched', 'approved'].includes(inv.status) && paid === 0 && credited === 0 && (
          <Button
            variant="danger"
            disabled={busy}
            onClick={() => {
              const reason = window.prompt('Why is this invoice rejected? (e.g. "Billed for goods we sent back")');
              if (reason && reason.trim())
                void act(() => supabase.rpc('reject_supplier_invoice', { p_invoice_id: inv.id, p_reason: reason.trim() }));
            }}
          >
            Reject
          </Button>
        )}
        <Button variant="ghost" onClick={onClose}>
          Close
        </Button>
      </div>
    </div>
  );
}

function Info({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div>
      <p className="text-[10px] uppercase tracking-wide text-muted">{label}</p>
      <p className={strong ? 'font-bold font-mono' : 'font-semibold'}>{value}</p>
    </div>
  );
}

function Row({ label, cents }: { label: string; cents: number }) {
  return (
    <tr>
      <td colSpan={5} className="pt-1 text-right">
        {label}
      </td>
      <td className="pt-1 text-right font-mono">{formatCents(cents)}</td>
    </tr>
  );
}
