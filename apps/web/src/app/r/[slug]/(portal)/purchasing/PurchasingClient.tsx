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
  supplier_name: string | null;
  purchase_order_lines: POLine[];
};

type DraftLine = { item_id: string; qty: string; cost: string };

const STATUS_STYLE: Record<PurchaseOrder['status'], string> = {
  draft: 'text-muted',
  sent: 'text-warn',
  partial: 'text-warn',
  received: 'text-ok',
  cancelled: 'text-danger',
};

const blankLine: DraftLine = { item_id: '', qty: '', cost: '' };

export function PurchasingClient({
  suppliers,
  items,
  orders,
}: {
  suppliers: Supplier[];
  items: Item[];
  orders: PurchaseOrder[];
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
    const { data: po, error: poErr } = await supabase
      .from('purchase_orders')
      .insert({
        po_number: poNumber,
        supplier_id: supplierId,
        status: 'sent',
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

  async function act(id: string, fn: () => PromiseLike<{ error: { message: string } | null }>) {
    setBusy(true);
    setError(null);
    const { error } = await fn();
    setBusy(false);
    if (error) {
      setError(error.message);
      return;
    }
    router.refresh();
  }

  return (
    <div className="space-y-6">
      {error && (
        <div className="rounded border border-danger/40 bg-danger/10 text-danger p-3 text-xs">
          {error}
        </div>
      )}

      <Card>
        <h2 className="font-bold mb-3 text-sm">New purchase order</h2>
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
                <Input
                  type="date"
                  value={expectedAt}
                  onChange={(e) => setExpectedAt(e.target.value)}
                />
              </Field>
              <Field label="Notes">
                <Input value={notes} onChange={(e) => setNotes(e.target.value)} />
              </Field>
            </div>

            <div className="space-y-2">
              {lines.map((l, i) => (
                <div key={i} className="grid grid-cols-[1fr_5rem_6rem_2rem] gap-2 items-end">
                  <Field label={i === 0 ? 'Item' : ''}>
                    <Select
                      value={l.item_id}
                      onChange={(e) => setLine(i, { item_id: e.target.value })}
                    >
                      <option value="">— pick —</option>
                      {items.map((it) => (
                        <option key={it.id} value={it.id}>
                          {it.name}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Field label={i === 0 ? 'Qty' : ''}>
                    <Input
                      type="number"
                      min="0"
                      step="0.001"
                      value={l.qty}
                      onChange={(e) => setLine(i, { qty: e.target.value })}
                    />
                  </Field>
                  <Field label={i === 0 ? 'Unit cost' : ''}>
                    <Input
                      type="number"
                      min="0"
                      step="0.01"
                      value={l.cost}
                      onChange={(e) => setLine(i, { cost: e.target.value })}
                    />
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
                Create &amp; send
              </Button>
            </div>
          </form>
        )}
      </Card>

      <div className="space-y-3">
        {orders.length === 0 ? (
          <Card>
            <p className="text-muted text-xs">No purchase orders yet.</p>
          </Card>
        ) : (
          orders.map((o) => {
            const total = o.purchase_order_lines.reduce(
              (s, l) => s + Math.round(Number(l.qty) * l.unit_cost_cents),
              0,
            );
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
                    <span className="font-mono text-body">{formatCents(total)}</span>
                  </div>
                </div>
                <table className="w-full text-left text-xs">
                  <tbody>
                    {o.purchase_order_lines.map((l) => (
                      <tr key={l.id} className="border-b border-border/50 last:border-0">
                        <td className="px-4 py-2">{l.description}</td>
                        <td className="px-4 py-2 text-right font-mono">
                          {Number(l.qty)}
                          {Number(l.received_qty) > 0 && Number(l.received_qty) < Number(l.qty)
                            ? ` (${Number(l.received_qty)} in)`
                            : ''}
                        </td>
                        <td className="px-4 py-2 text-right text-muted">
                          {formatCents(l.unit_cost_cents)}
                        </td>
                        <td className="px-4 py-2 text-right font-mono">
                          {formatCents(Math.round(Number(l.qty) * l.unit_cost_cents))}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <div className="flex items-center justify-between gap-2 p-3 bg-main/40">
                  <span className="text-[11px] text-muted">
                    {o.received_at
                      ? `received ${formatDateTime(o.received_at)}`
                      : `created ${formatDateTime(o.created_at)}`}
                  </span>
                  {open && (
                    <div className="flex gap-1.5">
                      <Button
                        variant="ghost"
                        disabled={busy}
                        onClick={() =>
                          act(o.id, () =>
                            supabase
                              .from('purchase_orders')
                              .update({ status: 'cancelled' })
                              .eq('id', o.id),
                          )
                        }
                      >
                        Cancel
                      </Button>
                      <Button
                        disabled={busy}
                        onClick={() =>
                          act(o.id, () =>
                            supabase.rpc('receive_purchase_order', { p_po_id: o.id }),
                          )
                        }
                      >
                        Receive &amp; stock
                      </Button>
                    </div>
                  )}
                </div>
              </Card>
            );
          })
        )}
      </div>
    </div>
  );
}
