'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { usePortalSupabase } from '@/components/PortalProvider';
import { Button, Card, Input } from '@/components/ui';
import { formatCents } from '@/lib/format';

type Line = {
  id: string;
  name_snapshot: string;
  qty: number;
  unit_price_cents: number;
  line_total_cents: number;
};
type Pay = {
  id: string;
  amount_cents: number;
  method: string;
  status: string;
  refunded_cents: number;
  created_at: string;
};
export type Bill = {
  id: string;
  order_number: number;
  session_id: string | null;
  table_label: string | null;
  customer_name: string | null;
  status: string;
  subtotal_cents: number;
  discount_cents: number;
  tax_cents: number;
  total_cents: number;
  refunded_cents: number;
  created_at: string;
  order_lines: Line[];
  payments: Pay[];
};

const UNPAID = ['pending', 'in_kitchen', 'ready', 'served'];
const METHODS = ['cash', 'card', 'mobile'] as const;

function netPaid(b: Bill): number {
  return b.payments
    .filter((p) => p.status !== 'voided')
    .reduce((s, p) => s + (p.amount_cents - p.refunded_cents), 0);
}
function due(b: Bill): number {
  return Math.max(0, b.total_cents - b.refunded_cents - netPaid(b));
}

/** Opens a small print-ready receipt in a new tab and triggers the browser
 *  print dialog. No PDF library, no server round-trip — just the same
 *  numbers already on screen, formatted for a till printer or A4 page. */
function printInvoice(bill: Bill, restaurantName: string) {
  const w = window.open('', '_blank', 'width=380,height=640');
  if (!w) return;
  const paidVia =
    bill.payments
      .filter((p) => p.status !== 'voided')
      .map((p) => `${p.method} ${formatCents(p.amount_cents - p.refunded_cents)}`)
      .join(', ') || 'unpaid';
  const esc = (s: string) => s.replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' })[c]!);
  w.document.write(`<!doctype html><html><head><title>Invoice #${bill.order_number}</title><meta charset="utf-8">
<style>
  body{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px;color:#111;padding:18px;max-width:340px}
  h1{font-size:14px;margin:0 0 2px}
  .muted{color:#666;font-size:10px;margin-bottom:2px}
  table{width:100%;border-collapse:collapse;margin-top:8px}
  td{padding:2px 0}
  .right{text-align:right}
  hr{border:none;border-top:1px dashed #999;margin:8px 0}
  .total{font-weight:bold;font-size:13px}
</style></head><body>
<h1>${esc(restaurantName)}</h1>
<div class="muted">Order #${bill.order_number}${bill.table_label ? ' · ' + esc(bill.table_label) : ''}${bill.customer_name ? ' · ' + esc(bill.customer_name) : ''}</div>
<div class="muted">${new Date(bill.created_at).toLocaleString()}</div>
<hr/>
<table>${bill.order_lines
    .map(
      (l) =>
        `<tr><td>${l.qty}&times; ${esc(l.name_snapshot)}</td><td class="right">${formatCents(l.line_total_cents)}</td></tr>`,
    )
    .join('')}</table>
<hr/>
<table>
<tr><td>Subtotal</td><td class="right">${formatCents(bill.subtotal_cents)}</td></tr>
${bill.discount_cents > 0 ? `<tr><td>Discount</td><td class="right">&minus;${formatCents(bill.discount_cents)}</td></tr>` : ''}
<tr><td>Tax</td><td class="right">${formatCents(bill.tax_cents)}</td></tr>
${bill.refunded_cents > 0 ? `<tr><td>Refunded</td><td class="right">&minus;${formatCents(bill.refunded_cents)}</td></tr>` : ''}
<tr class="total"><td>Total</td><td class="right">${formatCents(bill.total_cents)}</td></tr>
</table>
<hr/>
<div class="muted">Paid via: ${esc(paidVia)}</div>
<script>window.onload=function(){window.print();}<\/script>
</body></html>`);
  w.document.close();
}

export function CheckoutClient({
  restaurantName,
  initial,
  canRefund,
  canVoid,
  canDiscount,
  canCancel,
}: {
  restaurantName: string;
  initial: Bill[];
  canRefund: boolean;
  canVoid: boolean;
  canDiscount: boolean;
  canCancel: boolean;
}) {
  const router = useRouter();
  const supabase = usePortalSupabase();
  const [bills, setBills] = useState<Bill[]>(initial);
  const [open, setOpen] = useState<string | null>(initial[0]?.id ?? null);
  const [method, setMethod] = useState<(typeof METHODS)[number]>('cash');
  const [amount, setAmount] = useState('');
  const [tendered, setTendered] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(async () => {
    const { data } = await supabase
      .from('orders')
      .select(
        'id, order_number, session_id, table_label, customer_name, status, subtotal_cents, discount_cents, tax_cents, total_cents, refunded_cents, created_at, order_lines(id, name_snapshot, qty, unit_price_cents, line_total_cents), payments(id, amount_cents, method, status, refunded_cents, created_at)',
      )
      .in('status', UNPAID)
      .order('created_at', { ascending: true });
    if (data) setBills(data as Bill[]);
  }, [supabase]);

  useEffect(() => {
    const ch = supabase
      .channel('checkout')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'orders' }, () => load())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'payments' }, () => load())
      .subscribe();
    return () => {
      supabase.removeChannel(ch);
    };
  }, [supabase, load]);

  const bill = useMemo(() => bills.find((b) => b.id === open) ?? null, [bills, open]);
  const owed = bill ? due(bill) : 0;
  const amountCents = amount.trim() ? Math.round(parseFloat(amount) * 100) : owed;
  const tenderedCents = tendered.trim() ? Math.round(parseFloat(tendered) * 100) : null;
  const change =
    method === 'cash' && tenderedCents != null ? tenderedCents - amountCents : null;

  async function run(
    fn: () => PromiseLike<{ error: { message: string } | null }>,
    ok?: string,
  ) {
    setBusy(true);
    setError(null);
    setNote(null);
    const { error: e } = await fn();
    setBusy(false);
    if (e) {
      setError(e.message);
      return;
    }
    if (ok) setNote(ok);
    setAmount('');
    setTendered('');
    await load();
    router.refresh();
  }

  async function takePayment() {
    if (!bill || amountCents <= 0) return;
    await run(
      () =>
        supabase.rpc('record_payment', {
          p_order_id: bill.id,
          p_amount_cents: amountCents,
          p_method: method,
          p_tendered_cents: method === 'cash' ? tenderedCents : null,
          p_reference: null,
        }),
      'Payment recorded.',
    );
  }

  async function discount() {
    if (!bill) return;
    const v = window.prompt('Discount amount (in currency units):', '0');
    if (v == null) return;
    const cents = Math.max(0, Math.round(parseFloat(v || '0') * 100));
    const reason = window.prompt('Reason for the discount:') ?? '';
    await run(() =>
      supabase.rpc('apply_order_discount', {
        p_order_id: bill.id,
        p_discount_cents: cents,
        p_reason: reason,
      }),
    );
  }

  async function cancel() {
    if (!bill) return;
    const reason = window.prompt(`Cancel order #${bill.order_number}. Reason:`);
    if (!reason) return;
    await run(() => supabase.rpc('cancel_order', { p_order_id: bill.id, p_reason: reason }));
  }

  async function refund(p: Pay) {
    const max = (p.amount_cents - p.refunded_cents) / 100;
    const v = window.prompt(`Refund amount (max ${max.toFixed(2)}):`, max.toFixed(2));
    if (v == null) return;
    const reason = window.prompt('Reason for the refund:') ?? '';
    await run(
      () =>
        supabase.rpc('refund_payment', {
          p_payment_id: p.id,
          p_amount_cents: Math.round(parseFloat(v || '0') * 100),
          p_reason: reason,
          p_method: null,
        }),
      'Refund recorded.',
    );
  }

  async function voidPay(p: Pay) {
    const reason = window.prompt('Reason for voiding this payment:');
    if (!reason) return;
    await run(() => supabase.rpc('void_payment', { p_payment_id: p.id, p_reason: reason }));
  }

  if (bills.length === 0) {
    return (
      <div className="rounded-lg border border-border bg-surface p-10 text-center text-muted text-sm">
        No open bills.
      </div>
    );
  }

  return (
    <div className="flex flex-col lg:flex-row gap-4">
      <div className="lg:w-64 shrink-0 space-y-1.5">
        {bills.map((b) => (
          <button
            key={b.id}
            onClick={() => setOpen(b.id)}
            className={`w-full text-left rounded-lg border p-3 ${
              open === b.id ? 'border-primary bg-primary/5' : 'border-border bg-surface'
            }`}
          >
            <div className="flex justify-between text-xs">
              <span className="font-black">
                {b.table_label ? b.table_label : `#${b.order_number}`}
              </span>
              <span className={due(b) === 0 ? 'text-ok' : 'text-body font-bold'}>
                {due(b) === 0 ? 'paid' : formatCents(due(b))}
              </span>
            </div>
            <div className="text-[11px] text-muted">
              #{b.order_number} · {b.status.replace('_', ' ')}
            </div>
          </button>
        ))}
      </div>

      {bill && (
        <Card className="flex-1 min-w-0">
          <div className="flex items-baseline justify-between mb-3">
            <h2 className="font-black">
              Order #{bill.order_number}
              {bill.table_label ? ` · ${bill.table_label}` : ''}
            </h2>
            <div className="flex items-center gap-3">
              <span className="text-xs text-muted">{bill.customer_name ?? ''}</span>
              <button
                onClick={() => printInvoice(bill, restaurantName)}
                className="text-primary text-xs font-semibold underline"
              >
                Print invoice
              </button>
            </div>
          </div>

          <div className="space-y-1 text-xs mb-3">
            {bill.order_lines.map((l) => (
              <div key={l.id} className="flex justify-between">
                <span>
                  {l.qty}× {l.name_snapshot}
                </span>
                <span>{formatCents(l.line_total_cents)}</span>
              </div>
            ))}
          </div>

          <dl className="text-xs space-y-1 border-t border-border pt-2">
            <div className="flex justify-between">
              <dt className="text-muted">Subtotal</dt>
              <dd>{formatCents(bill.subtotal_cents)}</dd>
            </div>
            {bill.discount_cents > 0 && (
              <div className="flex justify-between">
                <dt className="text-muted">Discount</dt>
                <dd>−{formatCents(bill.discount_cents)}</dd>
              </div>
            )}
            <div className="flex justify-between">
              <dt className="text-muted">Tax</dt>
              <dd>{formatCents(bill.tax_cents)}</dd>
            </div>
            {bill.refunded_cents > 0 && (
              <div className="flex justify-between text-warn">
                <dt>Refunded</dt>
                <dd>−{formatCents(bill.refunded_cents)}</dd>
              </div>
            )}
            <div className="flex justify-between font-black text-sm pt-1">
              <dt>Amount due</dt>
              <dd>{formatCents(owed)}</dd>
            </div>
          </dl>

          {owed > 0 && (
            <div className="mt-4 space-y-2">
              <div className="grid grid-cols-3 gap-2">
                {METHODS.map((m) => (
                  <button
                    key={m}
                    onClick={() => setMethod(m)}
                    className={`rounded py-1.5 text-xs font-semibold capitalize ${
                      method === m ? 'bg-primary text-primary-fg' : 'border border-border'
                    }`}
                  >
                    {m}
                  </button>
                ))}
              </div>
              <div className="grid grid-cols-2 gap-2">
                <Input
                  placeholder={`Amount (${(owed / 100).toFixed(2)})`}
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                />
                {method === 'cash' && (
                  <Input
                    placeholder="Cash tendered"
                    value={tendered}
                    onChange={(e) => setTendered(e.target.value)}
                  />
                )}
              </div>
              {change != null && (
                <p className={`text-xs font-bold ${change < 0 ? 'text-danger' : 'text-ok'}`}>
                  {change < 0 ? 'Short ' : 'Change '}
                  {formatCents(Math.abs(change))}
                </p>
              )}
              <Button
                className="w-full"
                disabled={busy || amountCents <= 0 || (method === 'cash' && (change ?? 0) < 0)}
                onClick={takePayment}
              >
                {busy ? 'Working…' : `Take ${formatCents(amountCents)}`}
              </Button>
            </div>
          )}

          {bill.payments.length > 0 && (
            <div className="mt-4 border-t border-border pt-2 space-y-1">
              <div className="text-[10px] uppercase tracking-wide text-muted font-bold">Payments</div>
              {bill.payments.map((p) => (
                <div key={p.id} className="flex items-center justify-between text-xs">
                  <span className="capitalize">
                    {p.method} · {formatCents(p.amount_cents)}
                    {p.status !== 'captured' && (
                      <span className="text-warn"> · {p.status.replace('_', ' ')}</span>
                    )}
                  </span>
                  <span className="flex gap-1">
                    {canRefund && p.status !== 'voided' && p.refunded_cents < p.amount_cents && (
                      <button onClick={() => refund(p)} className="text-primary underline">
                        refund
                      </button>
                    )}
                    {canVoid && p.status === 'captured' && p.refunded_cents === 0 && (
                      <button onClick={() => voidPay(p)} className="text-danger underline">
                        void
                      </button>
                    )}
                  </span>
                </div>
              ))}
            </div>
          )}

          <div className="mt-4 flex gap-2 flex-wrap">
            {canDiscount && (
              <Button variant="ghost" onClick={discount} disabled={busy}>
                Discount
              </Button>
            )}
            {canCancel && bill.status !== 'void' && due(bill) === bill.total_cents - bill.refunded_cents && (
              <Button variant="ghost" onClick={cancel} disabled={busy}>
                Cancel order
              </Button>
            )}
          </div>

          {error && <p className="text-danger text-xs mt-2">{error}</p>}
          {note && <p className="text-ok text-xs mt-2">{note}</p>}
        </Card>
      )}
    </div>
  );
}
