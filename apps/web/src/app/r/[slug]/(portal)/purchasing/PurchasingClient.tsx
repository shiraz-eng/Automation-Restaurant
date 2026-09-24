'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { usePortalSupabase } from '@/components/PortalProvider';
import { Button, Card, Field, Input, Select } from '@/components/ui';
import { formatCents, formatDateTime } from '@/lib/format';

type Supplier = { id: string; name: string };
type Item = { id: string; unit: string; name: string };

type POLine = {
  id: string;
  description: string;
  qty: number;
  unit_cost_cents: number;
  received_qty: number;
  rejected_qty: number;
  reject_reason: string | null;
  inventory_item_id: string | null;
};

export type PurchaseOrder = {
  id: string;
  po_number: number;
  status: 'draft' | 'sent' | 'partial' | 'received' | 'cancelled';
  expected_at: string | null;
  notes: string | null;
  created_at: string;
  received_at: string | null;
  approved_at: string | null;
  sent_at: string | null;
  supplier_id: string;
  subtotal_cents: number;
  supplier_name: string | null;
  purchase_order_lines: POLine[];
};

export type Invoice = {
  id: string;
  invoice_ref: number;
  supplier_invoice_number: string;
  invoice_date: string;
  due_date: string | null;
  total_cents: number;
  status: string;
  purchase_order_id: string | null;
  supplier_id: string;
  suppliers: { name: string } | { name: string }[] | null;
};

export type Hold = {
  id: string;
  reason: string;
  amount_cents: number;
  status: string;
  created_at: string;
  invoice_id: string;
  supplier_invoices:
    | { supplier_invoice_number: string; suppliers: { name: string } | { name: string }[] | null }
    | { supplier_invoice_number: string; suppliers: { name: string } | { name: string }[] | null }[]
    | null;
};

export type PayableRow = {
  supplier_id: string;
  supplier_name: string;
  invoiced_cents: number;
  on_hold_cents: number;
  approved_cents: number;
  paid_cents: number;
  credited_cents: number;
  outstanding_cents: number;
  overdue_cents: number;
  open_invoices: number;
  open_holds: number;
};

type DraftLine = { item_id: string; qty: string; cost: string };

const STATUS_STYLE: Record<string, string> = {
  draft: 'text-muted',
  sent: 'text-warn',
  partial: 'text-warn',
  received: 'text-ok',
  cancelled: 'text-danger',
  matched: 'text-primary',
  on_hold: 'text-danger',
  approved: 'text-primary',
  partially_paid: 'text-warn',
  paid: 'text-ok',
};

const one = <T,>(v: T | T[] | null): T | null => (Array.isArray(v) ? (v[0] ?? null) : v);

const blankLine: DraftLine = { item_id: '', qty: '', cost: '' };

export function PurchasingClient({
  suppliers,
  items,
  orders,
  invoices,
  holds,
  payable,
  canInvoice,
  canMatch,
  canPay,
  canManagePayables,
  canViewPayables,
  canManagePO,
  canApprovePO,
  canReceive,
}: {
  suppliers: Supplier[];
  items: Item[];
  orders: PurchaseOrder[];
  invoices: Invoice[];
  holds: Hold[];
  payable: PayableRow[];
  canInvoice: boolean;
  canMatch: boolean;
  canPay: boolean;
  canManagePayables: boolean;
  canViewPayables: boolean;
  /** purchases.update — matches create/cancel/send_purchase_order()'s has_perm check. */
  canManagePO: boolean;
  /** purchases.approve — matches approve_purchase_order()'s has_perm check. */
  canApprovePO: boolean;
  /** purchases.receive or inventory.manage_purchases — matches receive_purchase_order[_line]()'s has_perm check. */
  canReceive: boolean;
}) {
  const router = useRouter();
  const supabase = usePortalSupabase();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [supplierId, setSupplierId] = useState('');
  const [expectedAt, setExpectedAt] = useState('');
  const [notes, setNotes] = useState('');
  const [lines, setLines] = useState<DraftLine[]>([{ ...blankLine }]);

  const itemById = useMemo(() => new Map(items.map((i) => [i.id, i])), [items]);

  const draftTotal = lines.reduce((sum, l) => {
    const q = parseFloat(l.qty);
    const c = parseFloat(l.cost);
    return sum + (Number.isNaN(q) || Number.isNaN(c) ? 0 : Math.round(q * c * 100));
  }, 0);

  function setLine(i: number, patch: Partial<DraftLine>) {
    setLines((ls) => ls.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));
  }

  async function act(fn: () => PromiseLike<{ error: { message: string } | null }>) {
    setBusy(true);
    setError(null);
    const { error } = await fn();
    setBusy(false);
    if (error) {
      setError(error.message);
      return false;
    }
    router.refresh();
    return true;
  }

  async function createPO(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const clean = lines
      .map((l) => ({
        item: itemById.get(l.item_id),
        qty: parseFloat(l.qty),
        cost: parseFloat(l.cost),
        item_id: l.item_id,
      }))
      .filter((l) => l.item && !Number.isNaN(l.qty) && l.qty > 0);
    if (!supplierId) {
      setError('Pick a supplier.');
      return;
    }
    if (clean.length === 0) {
      setError('Add at least one line with an item and a quantity.');
      return;
    }

    setBusy(true);
    const { data: poNumber, error: numErr } = await supabase.rpc('next_po_number');
    if (numErr) {
      setBusy(false);
      setError(numErr.message);
      return;
    }
    // Created as draft — needs Approve then Send before it can be received
    // against (spec: PO approval gate).
    const { data: po, error: poErr } = await supabase
      .from('purchase_orders')
      .insert({
        po_number: poNumber,
        supplier_id: supplierId,
        expected_at: expectedAt || null,
        notes: notes.trim() || null,
      })
      .select('id')
      .single();
    if (poErr || !po) {
      setBusy(false);
      setError(poErr?.message ?? 'Could not create the purchase order.');
      return;
    }
    const { error: linesErr } = await supabase.from('purchase_order_lines').insert(
      clean.map((l) => ({
        purchase_order_id: po.id,
        inventory_item_id: l.item_id,
        description: l.item!.name,
        qty: l.qty,
        unit_cost_cents: Number.isNaN(l.cost) ? 0 : Math.round(l.cost * 100),
      })),
    );
    setBusy(false);
    if (linesErr) {
      setError(linesErr.message);
      return;
    }
    setSupplierId('');
    setExpectedAt('');
    setNotes('');
    setLines([{ ...blankLine }]);
    router.refresh();
  }

  async function receiveLine(line: POLine) {
    const outstanding = Number(line.qty) - Number(line.received_qty);
    if (outstanding <= 0) return;
    const qtyStr = window.prompt(`Quantity delivered now for "${line.description}" (outstanding ${outstanding}):`, String(outstanding));
    if (qtyStr == null) return;
    const qty = parseFloat(qtyStr);
    if (!Number.isFinite(qty) || qty <= 0) {
      setError('Enter a valid quantity.');
      return;
    }
    const rejStr = window.prompt('How much of that was rejected (damaged/wrong/short)? Leave 0 if none:', '0');
    if (rejStr == null) return;
    const rejected = parseFloat(rejStr) || 0;
    let reason: string | null = null;
    if (rejected > 0) reason = window.prompt('Reason for rejection:', 'damaged') ?? 'damaged';
    await act(() =>
      supabase.rpc('receive_purchase_order_line', {
        p_line_id: line.id,
        p_qty: qty,
        p_rejected_qty: rejected,
        p_reject_reason: reason,
      }),
    );
  }

  // ── Supplier invoices ────────────────────────────────────────────────
  const [invSupplier, setInvSupplier] = useState('');
  const [invPo, setInvPo] = useState('');
  const [invNumber, setInvNumber] = useState('');
  const [invDate, setInvDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [invLines, setInvLines] = useState<
    { po_line_id: string; inventory_item_id: string; description: string; qty: string; unit_cost_cents: string }[]
  >([]);

  const supplierPOs = useMemo(() => orders.filter((p) => p.supplier_id === invSupplier), [orders, invSupplier]);

  function loadPOIntoInvoice(poId: string) {
    setInvPo(poId);
    const po = orders.find((p) => p.id === poId);
    if (!po) return;
    setInvLines(
      po.purchase_order_lines
        .filter((l) => Number(l.received_qty) - Number(l.rejected_qty) > 0)
        .map((l) => ({
          po_line_id: l.id,
          inventory_item_id: l.inventory_item_id ?? '',
          description: l.description,
          qty: String(Number(l.received_qty) - Number(l.rejected_qty)),
          unit_cost_cents: (l.unit_cost_cents / 100).toFixed(2),
        })),
    );
  }
  function addInvoiceLine() {
    setInvLines((ls) => [...ls, { po_line_id: '', inventory_item_id: '', description: '', qty: '', unit_cost_cents: '' }]);
  }
  function updateInvoiceLine(i: number, patch: Partial<(typeof invLines)[number]>) {
    setInvLines((ls) => ls.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));
  }

  async function createInvoice(e: React.FormEvent) {
    e.preventDefault();
    if (!invSupplier || !invNumber.trim()) {
      setError('Supplier and invoice number are required.');
      return;
    }
    const validLines = invLines.filter((l) => l.description.trim() && Number(l.qty) > 0);
    if (validLines.length === 0) {
      setError('Add at least one invoice line.');
      return;
    }
    setBusy(true);
    setError(null);
    const { data: inv, error: invErr } = await supabase
      .from('supplier_invoices')
      .insert({
        supplier_id: invSupplier,
        purchase_order_id: invPo || null,
        supplier_invoice_number: invNumber.trim(),
        invoice_date: invDate,
      })
      .select('id')
      .single();
    if (invErr || !inv) {
      setError(invErr?.message ?? 'Could not create invoice.');
      setBusy(false);
      return;
    }
    const rows = validLines.map((l) => {
      const cents = Math.round((Number(l.unit_cost_cents) || 0) * 100);
      const qty = Number(l.qty);
      return {
        invoice_id: inv.id,
        po_line_id: l.po_line_id || null,
        inventory_item_id: l.inventory_item_id || null,
        description: l.description.trim(),
        qty,
        unit_cost_cents: cents,
        line_total_cents: Math.round(cents * qty),
      };
    });
    const { error: linesErr } = await supabase.from('supplier_invoice_lines').insert(rows);
    if (linesErr) {
      setError(linesErr.message);
      setBusy(false);
      return;
    }
    const total = rows.reduce((s, r) => s + r.line_total_cents, 0);
    const { error: totErr } = await supabase
      .from('supplier_invoices')
      .update({ subtotal_cents: total, total_cents: total })
      .eq('id', inv.id);
    setBusy(false);
    if (totErr) {
      setError(totErr.message);
      return;
    }
    setInvSupplier('');
    setInvPo('');
    setInvNumber('');
    setInvLines([]);
    router.refresh();
  }

  // ── Payment holds ────────────────────────────────────────────────────
  async function resolveHold(h: Hold) {
    const note = window.prompt('Resolution note (what was checked / agreed):', '');
    if (note == null) return;
    await act(() => supabase.rpc('resolve_payment_hold', { p_hold_id: h.id, p_resolution_note: note }));
  }

  // ── Record payment ───────────────────────────────────────────────────
  const [paySupplier, setPaySupplier] = useState('');
  const [payAmount, setPayAmount] = useState('');
  const [payMethod, setPayMethod] = useState('bank_transfer');
  const [payReference, setPayReference] = useState('');
  const [payAllocations, setPayAllocations] = useState<Record<string, string>>({});

  const payableInvoices = useMemo(() => invoices.filter((i) => i.status === 'approved' || i.status === 'partially_paid'), [invoices]);
  const paySupplierInvoices = useMemo(() => payableInvoices.filter((i) => i.supplier_id === paySupplier), [payableInvoices, paySupplier]);

  async function recordPayment(e: React.FormEvent) {
    e.preventDefault();
    const amount = Math.round((Number(payAmount) || 0) * 100);
    if (!paySupplier || amount <= 0) {
      setError('Choose a supplier and enter a positive amount.');
      return;
    }
    const allocations = Object.entries(payAllocations)
      .map(([invoice_id, v]) => ({ invoice_id, amount_cents: Math.round((Number(v) || 0) * 100) }))
      .filter((a) => a.amount_cents > 0);
    const ok = await act(() =>
      supabase.rpc('record_supplier_payment', {
        p_supplier_id: paySupplier,
        p_amount_cents: amount,
        p_method: payMethod,
        p_reference: payReference.trim() || null,
        p_allocations: allocations,
      }),
    );
    if (ok) {
      setPayAmount('');
      setPayReference('');
      setPayAllocations({});
    }
  }

  return (
    <div className="space-y-8">
      {error && (
        <div className="rounded border border-danger/40 bg-danger/10 text-danger p-3 text-xs">
          {error}
        </div>
      )}

      {/* Where is our money? */}
      {canViewPayables && (
        <section>
          <h2 className="font-bold text-sm mb-3">Where is our money? — accounts payable</h2>
          {payable.filter((r) => r.invoiced_cents > 0).length === 0 ? (
            <Card>
              <p className="text-muted text-xs">No invoices recorded yet.</p>
            </Card>
          ) : (
            <Card className="p-0 overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead className="text-muted border-b border-border">
                    <tr>
                      <th className="p-3 font-semibold">Supplier</th>
                      <th className="p-3 font-semibold text-right">Invoiced</th>
                      <th className="p-3 font-semibold text-right">Approved</th>
                      <th className="p-3 font-semibold text-right">On hold</th>
                      <th className="p-3 font-semibold text-right">Paid</th>
                      <th className="p-3 font-semibold text-right">Credited</th>
                      <th className="p-3 font-semibold text-right">Outstanding</th>
                      <th className="p-3 font-semibold text-right">Overdue</th>
                    </tr>
                  </thead>
                  <tbody>
                    {payable
                      .filter((r) => r.invoiced_cents > 0)
                      .map((r) => (
                        <tr key={r.supplier_id} className="border-b border-border/60 last:border-0">
                          <td className="p-3 font-semibold">{r.supplier_name}</td>
                          <td className="p-3 text-right font-mono">{formatCents(r.invoiced_cents)}</td>
                          <td className="p-3 text-right font-mono text-primary">{formatCents(r.approved_cents)}</td>
                          <td className="p-3 text-right font-mono text-danger">{formatCents(r.on_hold_cents)}</td>
                          <td className="p-3 text-right font-mono text-ok">{formatCents(r.paid_cents)}</td>
                          <td className="p-3 text-right font-mono text-muted">{formatCents(r.credited_cents)}</td>
                          <td className="p-3 text-right font-mono font-bold">{formatCents(r.outstanding_cents)}</td>
                          <td className={`p-3 text-right font-mono ${r.overdue_cents > 0 ? 'text-danger font-bold' : 'text-muted'}`}>
                            {formatCents(r.overdue_cents)}
                          </td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
            </Card>
          )}
        </section>
      )}

      {/* Payment holds */}
      {canManagePayables && (
        <section>
          <h2 className="font-bold text-sm mb-3">
            What&apos;s on hold? {holds.length > 0 && <span className="text-danger">({holds.length})</span>}
          </h2>
          {holds.length === 0 ? (
            <Card>
              <p className="text-muted text-xs">Nothing on hold.</p>
            </Card>
          ) : (
            <div className="space-y-2">
              {holds.map((h) => {
                const inv = one(h.supplier_invoices);
                const sup = inv ? one(inv.suppliers) : null;
                return (
                  <Card key={h.id} className="flex items-center justify-between gap-3">
                    <div>
                      <p className="text-sm font-semibold">
                        {sup?.name ?? '—'} · {inv?.supplier_invoice_number ?? '—'} · {formatCents(h.amount_cents)}
                      </p>
                      <p className="text-xs text-danger mt-0.5">{h.reason}</p>
                    </div>
                    <Button variant="ghost" disabled={busy} onClick={() => resolveHold(h)}>
                      Resolve
                    </Button>
                  </Card>
                );
              })}
            </div>
          )}
        </section>
      )}

      {/* Purchase orders */}
      <section>
        <h2 className="font-bold text-sm mb-3">Purchase orders</h2>
        {canManagePO && (
        <Card>
          <h3 className="font-bold mb-3 text-sm">New purchase order</h3>
          {suppliers.length === 0 ? (
            <p className="text-muted text-xs">Add a supplier first.</p>
          ) : (
            <form onSubmit={createPO} className="space-y-3">
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <Field label="Supplier">
                  <Select value={supplierId} onChange={(e) => setSupplierId(e.target.value)}>
                    <option value="">— pick —</option>
                    {suppliers.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Expected date">
                  <Input type="date" value={expectedAt} onChange={(e) => setExpectedAt(e.target.value)} />
                </Field>
                <Field label="Notes">
                  <Input value={notes} onChange={(e) => setNotes(e.target.value)} />
                </Field>
              </div>

              <div className="space-y-2">
                {lines.map((l, i) => (
                  <div key={i} className="grid grid-cols-[1fr_5rem_6rem_2rem] gap-2 items-end">
                    <Field label={i === 0 ? 'Item' : ''}>
                      <Select value={l.item_id} onChange={(e) => setLine(i, { item_id: e.target.value })}>
                        <option value="">— pick —</option>
                        {items.map((it) => (
                          <option key={it.id} value={it.id}>
                            {it.name}
                          </option>
                        ))}
                      </Select>
                    </Field>
                    <Field label={i === 0 ? 'Qty' : ''}>
                      <Input type="number" min="0" step="0.001" value={l.qty} onChange={(e) => setLine(i, { qty: e.target.value })} />
                    </Field>
                    <Field label={i === 0 ? 'Unit cost' : ''}>
                      <Input type="number" min="0" step="0.01" value={l.cost} onChange={(e) => setLine(i, { cost: e.target.value })} />
                    </Field>
                    <button
                      type="button"
                      aria-label="Remove line"
                      className="h-8 rounded border border-border text-muted hover:bg-main disabled:opacity-40"
                      disabled={lines.length === 1}
                      onClick={() => setLines((ls) => ls.filter((_, idx) => idx !== i))}
                    >
                      ×
                    </button>
                  </div>
                ))}
                <button
                  type="button"
                  className="text-xs font-semibold text-primary"
                  onClick={() => setLines((ls) => [...ls, { ...blankLine }])}
                >
                  + add line
                </button>
              </div>

              <div className="flex items-center justify-between border-t border-border pt-3">
                <span className="text-xs text-muted">
                  Est. total <span className="font-mono text-body">{formatCents(draftTotal)}</span>
                </span>
                <Button type="submit" disabled={busy}>
                  Create as draft
                </Button>
              </div>
            </form>
          )}
        </Card>
        )}

        <div className="space-y-3 mt-3">
          {orders.length === 0 ? (
            <Card>
              <p className="text-muted text-xs">No purchase orders yet.</p>
            </Card>
          ) : (
            orders.map((o) => {
              const total = o.purchase_order_lines.reduce((s, l) => s + Math.round(Number(l.qty) * l.unit_cost_cents), 0);
              const open = o.status !== 'received' && o.status !== 'cancelled';
              return (
                <Card key={o.id} className="p-0 overflow-hidden">
                  <div className="flex flex-wrap items-baseline justify-between gap-2 p-4 border-b border-border">
                    <div>
                      <span className="font-black">PO #{o.po_number}</span>
                      <span className="text-muted text-xs ml-2">{o.supplier_name ?? '—'}</span>
                    </div>
                    <div className="text-xs text-muted flex items-center gap-3">
                      {o.expected_at && <span>due {o.expected_at}</span>}
                      <span className={`font-bold ${STATUS_STYLE[o.status]}`}>{o.status}</span>
                      {o.status === 'draft' && !o.approved_at && <span className="text-warn font-bold">needs approval</span>}
                      <span className="font-mono text-body">{formatCents(total)}</span>
                    </div>
                  </div>
                  <table className="w-full text-left text-xs">
                    <tbody>
                      {o.purchase_order_lines.map((l) => {
                        const outstanding = Number(l.qty) - Number(l.received_qty);
                        return (
                          <tr key={l.id} className="border-b border-border/50 last:border-0">
                            <td className="px-4 py-2">{l.description}</td>
                            <td className="px-4 py-2 text-right font-mono">
                              {Number(l.qty)}
                              {Number(l.received_qty) > 0 && Number(l.received_qty) < Number(l.qty) ? ` (${Number(l.received_qty)} in)` : ''}
                              {Number(l.rejected_qty) > 0 && <span className="text-danger"> −{Number(l.rejected_qty)} rej.</span>}
                            </td>
                            <td className="px-4 py-2 text-right text-muted">{formatCents(l.unit_cost_cents)}</td>
                            <td className="px-4 py-2 text-right font-mono">{formatCents(Math.round(Number(l.qty) * l.unit_cost_cents))}</td>
                            <td className="px-4 py-2 text-right">
                              {canReceive && ['sent', 'partial'].includes(o.status) && outstanding > 0 && (
                                <button
                                  onClick={() => receiveLine(l)}
                                  disabled={busy}
                                  className="text-primary underline decoration-dotted text-[11px]"
                                >
                                  receive
                                </button>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                  <div className="flex items-center justify-between gap-2 p-3 bg-main/40">
                    <span className="text-[11px] text-muted">
                      {o.received_at ? `received ${formatDateTime(o.received_at)}` : `created ${formatDateTime(o.created_at)}`}
                    </span>
                    {open && (
                      <div className="flex gap-1.5">
                        {canManagePO && o.status === 'draft' && (
                          <Button
                            variant="ghost"
                            disabled={busy}
                            onClick={() => act(() => supabase.from('purchase_orders').update({ status: 'cancelled' }).eq('id', o.id))}
                          >
                            Cancel
                          </Button>
                        )}
                        {canApprovePO && o.status === 'draft' && !o.approved_at && (
                          <Button disabled={busy} onClick={() => act(() => supabase.rpc('approve_purchase_order', { p_po_id: o.id }))}>
                            Approve
                          </Button>
                        )}
                        {canManagePO && o.status === 'draft' && o.approved_at && (
                          <Button disabled={busy} onClick={() => act(() => supabase.rpc('send_purchase_order', { p_po_id: o.id }))}>
                            Send
                          </Button>
                        )}
                        {canReceive && ['sent', 'partial'].includes(o.status) && (
                          <Button
                            variant="ghost"
                            disabled={busy}
                            onClick={() => act(() => supabase.rpc('receive_purchase_order', { p_po_id: o.id }))}
                          >
                            Receive all &amp; stock
                          </Button>
                        )}
                      </div>
                    )}
                  </div>
                </Card>
              );
            })
          )}
        </div>
      </section>

      {/* Supplier invoices */}
      {canInvoice && (
        <section>
          <h2 className="font-bold text-sm mb-3">Supplier invoices</h2>
          <Card className="mb-3">
            <form onSubmit={createInvoice} className="space-y-3">
              <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
                <Field label="Supplier">
                  <Select
                    value={invSupplier}
                    onChange={(e) => {
                      setInvSupplier(e.target.value);
                      setInvPo('');
                      setInvLines([]);
                    }}
                  >
                    <option value="">Choose…</option>
                    {suppliers.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="From purchase order (optional)">
                  <Select value={invPo} onChange={(e) => loadPOIntoInvoice(e.target.value)} disabled={!invSupplier}>
                    <option value="">Standalone (no PO)</option>
                    {supplierPOs.map((p) => (
                      <option key={p.id} value={p.id}>
                        PO #{p.po_number}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Supplier's invoice #">
                  <Input value={invNumber} onChange={(e) => setInvNumber(e.target.value)} placeholder="INV-1042" />
                </Field>
                <Field label="Invoice date">
                  <Input type="date" value={invDate} onChange={(e) => setInvDate(e.target.value)} />
                </Field>
              </div>
              {invLines.map((l, i) => (
                <div key={i} className="grid grid-cols-1 sm:grid-cols-4 gap-3 items-end">
                  <Field label="Description">
                    <Input value={l.description} onChange={(e) => updateInvoiceLine(i, { description: e.target.value })} />
                  </Field>
                  <Field label="Qty">
                    <Input type="number" min="0" step="0.001" value={l.qty} onChange={(e) => updateInvoiceLine(i, { qty: e.target.value })} />
                  </Field>
                  <Field label="Unit cost">
                    <Input
                      type="number"
                      min="0"
                      step="0.01"
                      value={l.unit_cost_cents}
                      onChange={(e) => updateInvoiceLine(i, { unit_cost_cents: e.target.value })}
                    />
                  </Field>
                  {i === invLines.length - 1 && (
                    <Button type="button" variant="ghost" onClick={addInvoiceLine}>
                      + line
                    </Button>
                  )}
                </div>
              ))}
              {invLines.length === 0 && (
                <Button type="button" variant="ghost" onClick={addInvoiceLine}>
                  + line
                </Button>
              )}
              <Button type="submit" disabled={busy}>
                Record invoice
              </Button>
            </form>
          </Card>

          <div className="space-y-3">
            {invoices.length === 0 ? (
              <Card>
                <p className="text-muted text-xs">No invoices recorded yet.</p>
              </Card>
            ) : (
              invoices.map((inv) => {
                const sup = one(inv.suppliers);
                return (
                  <Card key={inv.id} className="flex items-center justify-between gap-3">
                    <div>
                      <p className="text-sm font-semibold">
                        {sup?.name ?? '—'} · {inv.supplier_invoice_number} · {formatCents(inv.total_cents)}{' '}
                        <span className={`ml-2 text-[11px] uppercase font-bold ${STATUS_STYLE[inv.status] ?? ''}`}>{inv.status}</span>
                      </p>
                      <p className="text-[11px] text-muted mt-0.5">
                        Invoiced {inv.invoice_date}
                        {inv.due_date ? ` · due ${inv.due_date}` : ''}
                      </p>
                    </div>
                    <div className="flex gap-2 shrink-0">
                      {canMatch && inv.status === 'received' && (
                        <Button variant="ghost" disabled={busy} onClick={() => act(() => supabase.rpc('match_supplier_invoice', { p_invoice_id: inv.id }))}>
                          Run match
                        </Button>
                      )}
                      {canMatch && inv.status === 'matched' && (
                        <Button variant="ghost" disabled={busy} onClick={() => act(() => supabase.rpc('approve_supplier_invoice', { p_invoice_id: inv.id }))}>
                          Approve
                        </Button>
                      )}
                    </div>
                  </Card>
                );
              })
            )}
          </div>
        </section>
      )}

      {/* Record payment */}
      {canPay && (
        <section>
          <h2 className="font-bold text-sm mb-3">Record a supplier payment</h2>
          <Card>
            <form onSubmit={recordPayment} className="space-y-3">
              <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
                <Field label="Supplier">
                  <Select
                    value={paySupplier}
                    onChange={(e) => {
                      setPaySupplier(e.target.value);
                      setPayAllocations({});
                    }}
                  >
                    <option value="">Choose…</option>
                    {suppliers.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Amount paid">
                  <Input type="number" min="0.01" step="0.01" value={payAmount} onChange={(e) => setPayAmount(e.target.value)} />
                </Field>
                <Field label="Method">
                  <Select value={payMethod} onChange={(e) => setPayMethod(e.target.value)}>
                    <option value="bank_transfer">Bank transfer</option>
                    <option value="cash">Cash</option>
                    <option value="cheque">Cheque</option>
                    <option value="card">Card</option>
                  </Select>
                </Field>
                <Field label="Reference">
                  <Input value={payReference} onChange={(e) => setPayReference(e.target.value)} placeholder="TXN ref / cheque #" />
                </Field>
              </div>
              {paySupplier && (
                <div>
                  <p className="text-[11px] text-muted mb-2">
                    Allocate this payment across this supplier&apos;s approved/partially-paid invoices — amounts are validated against
                    the real outstanding balance when submitted.
                  </p>
                  {paySupplierInvoices.length === 0 ? (
                    <p className="text-muted text-xs">No approved or partially-paid invoices for this supplier.</p>
                  ) : (
                    <div className="space-y-2">
                      {paySupplierInvoices.map((inv) => (
                        <div key={inv.id} className="flex items-center gap-3 text-xs">
                          <span className="flex-1">
                            {inv.supplier_invoice_number} — total {formatCents(inv.total_cents)}
                          </span>
                          <Input
                            type="number"
                            min="0"
                            step="0.01"
                            className="w-28"
                            placeholder="allocate"
                            value={payAllocations[inv.id] ?? ''}
                            onChange={(e) => setPayAllocations((a) => ({ ...a, [inv.id]: e.target.value }))}
                          />
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
              <Button type="submit" disabled={busy}>
                Record payment
              </Button>
            </form>
          </Card>
        </section>
      )}
    </div>
  );
}
