'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { usePortalSupabase } from '@/components/PortalProvider';
import { Button, Card, Input } from '@/components/ui';
import { formatCents } from '@/lib/format';
import { downloadReceiptPdf } from '@/lib/generateReceipt';
import { renderReceiptBlocksHtml, RECEIPT_PRINT_STYLES } from '@/lib/receiptHtml';
import {
  buildReceiptBlocks,
  DEFAULT_RECEIPT_CONFIG,
  type ReceiptConfig as ReceiptTemplateConfig,
  type ReceiptContext,
} from '@/lib/receiptTemplate';
import { NewOrderPanel } from './NewOrderPanel';

/** Everything printInvoice()/downloadReceiptPdf() need about this
 *  restaurant's receipt configuration — one shared shape so both outputs
 *  read the same source (spec: "the receipt configuration should be the
 *  common source"). receiptConfig is null until the Owner has configured
 *  one in Brand Kit → Receipt; templateHtml (an older, still-supported
 *  escape valve) takes priority over it when both are set. */
export type ReceiptSettings = {
  logoUrl: string | null;
  /** Brand Kit's accent color ("R G B" channel string) — highlights the
   *  PDF download's TOTAL row. Printed thermal receipts stay monochrome. */
  primaryColor: string | null;
  footerText: string | null;
  templateHtml: string | null;
  receiptConfig: ReceiptTemplateConfig | null;
  restaurant: { address: string | null; phone: string | null; email: string | null; website: string | null; taxId: string | null };
};
export type NewOrderCategory = { id: string; name: string };
export type NewOrderItem = {
  id: string;
  name: string;
  category_id: string | null;
  menu_variants: { id: string; name: string; price_cents: number; sort_order: number; is_available: boolean; computed_available?: boolean }[];
};

type Line = {
  id: string;
  name_snapshot: string;
  variant_name_snapshot: string | null;
  qty: number;
  unit_price_cents: number;
  line_total_cents: number;
  modifiers: { id: string; name: string; price_cents: number }[];
  customer_note: string | null;
};
type Pay = {
  id: string;
  amount_cents: number;
  method: string;
  reference: string | null;
  tendered_cents: number | null;
  change_cents: number | null;
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
  channel: string;
  status: string;
  subtotal_cents: number;
  discount_cents: number;
  tax_cents: number;
  tax_rate_bps: number;
  total_cents: number;
  refunded_cents: number;
  created_at: string;
  paid_at: string | null;
  order_lines: Line[];
  payments: Pay[];
};

/** bill + restaurant/receipt settings -> the authoritative ReceiptContext
 *  both printInvoice() and the Download PDF button hand to the shared
 *  block builder. paidViaOverride lets a just-taken payment (not yet
 *  refetched into `bill.payments`) show up immediately. */
function toReceiptContext(bill: Bill, restaurantName: string, receipt: ReceiptSettings, paidViaOverride?: { method: string; amountCents: number }): ReceiptContext {
  const activePayments = bill.payments.filter((p) => p.status !== 'voided');
  const lastPayment = activePayments[activePayments.length - 1] ?? null;
  return {
    restaurantName,
    logoUrl: receipt.logoUrl,
    primaryColor: receipt.primaryColor,
    address: receipt.restaurant.address,
    phone: receipt.restaurant.phone,
    email: receipt.restaurant.email,
    website: receipt.restaurant.website,
    taxId: receipt.restaurant.taxId,
    orderNumber: bill.order_number,
    tableLabel: bill.table_label,
    customerName: bill.customer_name,
    orderType: bill.channel ? bill.channel.replace('_', ' ') : null,
    createdAt: bill.created_at,
    paidAt: bill.paid_at,
    orderStatus: bill.status ? bill.status.replace('_', ' ') : null,
    lines: bill.order_lines.map((l) => ({
      qty: l.qty,
      name: l.name_snapshot,
      variantName: l.variant_name_snapshot,
      modifiers: l.modifiers,
      notes: l.customer_note,
      unitPriceCents: l.unit_price_cents,
      lineTotalCents: l.line_total_cents,
    })),
    subtotalCents: bill.subtotal_cents,
    discountCents: bill.discount_cents,
    taxCents: bill.tax_cents,
    taxRateBps: bill.tax_rate_bps,
    totalCents: bill.total_cents,
    refundedCents: bill.refunded_cents,
    paymentMethod: paidViaOverride?.method ?? lastPayment?.method ?? null,
    paymentReference: lastPayment?.reference ?? null,
    amountPaidCents: paidViaOverride?.amountCents ?? lastPayment?.amount_cents ?? null,
    changeCents: paidViaOverride ? null : (lastPayment?.change_cents ?? null),
  };
}

/** When the Owner has never opened the new Receipt Customization builder,
 *  fall back to the same information the old hard-coded layout showed
 *  (spec: "use the existing receipt format" — not a second layout, just
 *  the default config seeded from whatever legacy footer text exists). */
function effectiveReceiptConfig(receipt: ReceiptSettings): ReceiptTemplateConfig {
  if (receipt.receiptConfig) return receipt.receiptConfig;
  return {
    ...DEFAULT_RECEIPT_CONFIG,
    customText: receipt.footerText
      ? [{ id: 'legacy-footer', text: receipt.footerText, align: 'center', bold: false }]
      : DEFAULT_RECEIPT_CONFIG.customText,
  };
}

const UNPAID = ['pending', 'in_kitchen', 'ready', 'served'];
const METHODS = ['cash', 'card', 'mobile'] as const;
/** Methods adjust_payment() accepts. */
const ADJUST_METHODS = ['cash', 'card', 'mobile', 'online', 'wallet', 'other'] as const;

function netPaid(b: Bill): number {
  return b.payments
    .filter((p) => p.status !== 'voided')
    .reduce((s, p) => s + (p.amount_cents - p.refunded_cents), 0);
}
function due(b: Bill): number {
  return Math.max(0, b.total_cents - b.refunded_cents - netPaid(b));
}

const esc = (s: string) => s.replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' })[c]!);

/** Substitutes {{placeholder}} tokens in an owner-supplied custom receipt
 *  template. Plain string replacement only — never evaluated/executed —
 *  so a malformed or even hostile template can only ever mis-print, never
 *  run anything. */
function renderCustomTemplate(html: string, tokens: Record<string, string>): string {
  return html.replace(/\{\{\s*([a-z_]+)\s*\}\}/gi, (m, key: string) => tokens[key.toLowerCase()] ?? '');
}

/** Opens a small print-ready receipt in a new tab and triggers the browser
 *  print dialog. No server round-trip — the same numbers already on
 *  screen. Uses the owner's raw HTML template (an older escape valve,
 *  still supported) when one is set; otherwise walks the SAME
 *  ReceiptBlock list buildReceiptDoc() (the PDF path) and the Brand Kit
 *  settings page's live preview walk, built from the restaurant's
 *  receipt_config — one shared source, not a separate layout per output.
 *
 *  Accepts an already-opened window when the caller can't call
 *  window.open() itself inside a user gesture (e.g. right after an
 *  awaited RPC) — most browsers silently block window.open() called
 *  asynchronously, so takePayment() below opens the blank window
 *  SYNCHRONOUSLY on click, before awaiting record_payment, and hands
 *  that handle in here once the payment succeeds. */
function printInvoice(bill: Bill, restaurantName: string, receipt: ReceiptSettings, paidViaOverride?: { method: string; amountCents: number }, existingWindow?: Window | null) {
  const w = existingWindow ?? window.open('', '_blank', 'width=380,height=640');
  if (!w) return;

  let body: string;
  if (receipt.templateHtml) {
    const paidVia =
      (paidViaOverride ? `${paidViaOverride.method} ${formatCents(paidViaOverride.amountCents)}` : null) ??
      (bill.payments
        .filter((p) => p.status !== 'voided')
        .map((p) => `${p.method} ${formatCents(p.amount_cents - p.refunded_cents)}`)
        .join(', ') ||
        'unpaid');
    const logoHtml = receipt.logoUrl ? `<img src="${esc(receipt.logoUrl)}" alt="" style="max-width:120px;max-height:60px;display:block;margin:0 auto 8px" />` : '';
    const linesHtml = bill.order_lines
      .map((l) => `<tr><td>${l.qty}&times; ${esc(l.name_snapshot)}</td><td class="right">${formatCents(l.line_total_cents)}</td></tr>`)
      .join('');
    const discountRow = bill.discount_cents > 0 ? `<tr><td>Discount</td><td class="right">&minus;${formatCents(bill.discount_cents)}</td></tr>` : '';
    const refundedRow = bill.refunded_cents > 0 ? `<tr><td>Refunded</td><td class="right">&minus;${formatCents(bill.refunded_cents)}</td></tr>` : '';
    const footerHtml = receipt.footerText ? `<div class="muted" style="margin-top:8px">${esc(receipt.footerText)}</div>` : '';
    body = renderCustomTemplate(receipt.templateHtml, {
      restaurant_name: esc(restaurantName),
      logo_html: logoHtml,
      order_number: String(bill.order_number),
      table: bill.table_label ? esc(bill.table_label) : '',
      customer: bill.customer_name ? esc(bill.customer_name) : '',
      date: new Date(bill.created_at).toLocaleString(),
      lines_html: linesHtml,
      subtotal: formatCents(bill.subtotal_cents),
      discount_row: discountRow,
      tax: formatCents(bill.tax_cents),
      refunded_row: refundedRow,
      total: formatCents(bill.total_cents),
      paid_via: esc(paidVia),
      footer: footerHtml,
    });
  } else {
    const ctx = toReceiptContext(bill, restaurantName, receipt, paidViaOverride);
    const config = effectiveReceiptConfig(receipt);
    body = renderReceiptBlocksHtml(buildReceiptBlocks(config, ctx));
  }

  w.document.write(`<!doctype html><html><head><title>Invoice #${bill.order_number}</title><meta charset="utf-8">
<style>${RECEIPT_PRINT_STYLES}</style></head><body>
${body}
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
  canTakePayment,
  receipt,
  canCreateOrder,
  taxRateBps,
  menuCategories,
  menuItems,
  canViewReceipt = true,
  canPrintReceipt = true,
  canOverridePrice = false,
  canAdjustPayment = false,
  canApproveRefund = false,
  refundThresholdCents = null,
}: {
  restaurantName: string;
  initial: Bill[];
  canRefund: boolean;
  canVoid: boolean;
  canDiscount: boolean;
  canCancel: boolean;
  /** payments.accept — matches record_payment()'s has_perm check (no
   *  can_write()/is_staff() fallback there, unlike most other RPCs). */
  canTakePayment: boolean;
  receipt: ReceiptSettings;
  canCreateOrder: boolean;
  taxRateBps: number;
  menuCategories: NewOrderCategory[];
  menuItems: NewOrderItem[];
  /** receipts.view — the Download PDF receipt. */
  canViewReceipt?: boolean;
  /** receipts.print — Print invoice, and the automatic print after a payment. */
  canPrintReceipt?: boolean;
  /** orders.override_price — override_line_price(). */
  canOverridePrice?: boolean;
  /** payments.adjust — adjust_payment() (method/reference correction). */
  canAdjustPayment?: boolean;
  /** payments.approve_refund — refund_payment() lifts the approval threshold. */
  canApproveRefund?: boolean;
  /** business_settings.max_refund_without_approval_cents (null = no limit). */
  refundThresholdCents?: number | null;
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
  const [viewMode, setViewMode] = useState<'bills' | 'new'>(initial.length === 0 ? 'new' : 'bills');

  const load = useCallback(async () => {
    const { data } = await supabase
      .from('orders')
      .select(
        'id, order_number, session_id, table_label, customer_name, channel, status, subtotal_cents, discount_cents, tax_cents, tax_rate_bps, total_cents, refunded_cents, created_at, paid_at, order_lines(id, name_snapshot, variant_name_snapshot, qty, unit_price_cents, line_total_cents, modifiers, customer_note), payments(id, amount_cents, method, reference, tendered_cents, change_cents, status, refunded_cents, created_at)',
      )
      .in('status', UNPAID)
      .order('created_at', { ascending: true });
    if (data) setBills(data as unknown as Bill[]);
  }, [supabase]);

  async function onOrderPlaced(orderId: string) {
    await load();
    setOpen(orderId);
    setViewMode('bills');
    router.refresh();
  }

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
  ): Promise<boolean> {
    setBusy(true);
    setError(null);
    setNote(null);
    const { error: e } = await fn();
    setBusy(false);
    if (e) {
      setError(
        /refund_needs_approval/.test(e.message)
          ? `Refunds above ${formatCents(refundThresholdCents ?? 0)} need someone with refund approval.`
          : e.message,
      );
      return false;
    }
    if (ok) setNote(ok);
    setAmount('');
    setTendered('');
    await load();
    router.refresh();
    return true;
  }

  async function takePayment() {
    if (!bill || amountCents <= 0) return;
    const paidBill = bill;
    const paidMethod = method;
    const paidAmount = amountCents;
    // Must open synchronously, still inside this click's user gesture —
    // opening it AFTER the awaited RPC below gets silently blocked as a
    // popup by most browsers. Written into (or closed) once the RPC settles.
    const printWindow = canPrintReceipt ? window.open('', '_blank', 'width=380,height=640') : null;
    const ok = await run(
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
    // Print immediately on a successful payment — line items/totals don't
    // change from taking a payment, so the pre-payment bill plus what was
    // just taken is already the accurate receipt; no need to wait on the
    // refetch to know what to print.
    if (ok && canPrintReceipt) {
      printInvoice(paidBill, restaurantName, receipt, { method: paidMethod, amountCents: paidAmount }, printWindow);
    } else {
      printWindow?.close();
    }
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

  async function overridePrice(line: Bill['order_lines'][number]) {
    const v = window.prompt(`New unit price for ${line.name_snapshot}:`, (line.unit_price_cents / 100).toFixed(2));
    if (v == null) return;
    const cents = Math.round(parseFloat(v) * 100);
    if (!Number.isFinite(cents) || cents < 0) {
      setError('Enter a valid price.');
      return;
    }
    const reason = window.prompt('Reason for the price override:');
    if (!reason) return;
    await run(
      () => supabase.rpc('override_line_price', { p_line_id: line.id, p_unit_price_cents: cents, p_reason: reason }),
      'Price updated.',
    );
  }

  async function adjustPayment(p: Pay) {
    const m = window.prompt(`Correct the payment method (${ADJUST_METHODS.join(', ')}):`, p.method);
    if (m == null) return;
    const method = m.trim().toLowerCase();
    if (!(ADJUST_METHODS as readonly string[]).includes(method)) {
      setError(`Method must be one of: ${ADJUST_METHODS.join(', ')}.`);
      return;
    }
    const ref = window.prompt('Reference (card slip / transaction id, optional):', p.reference ?? '') ?? '';
    const reason = window.prompt('Reason for the correction:');
    if (!reason) return;
    await run(
      () => supabase.rpc('adjust_payment', { p_payment_id: p.id, p_method: method, p_reference: ref, p_reason: reason }),
      'Payment corrected.',
    );
  }

  async function voidPay(p: Pay) {
    const reason = window.prompt('Reason for voiding this payment:');
    if (!reason) return;
    await run(() => supabase.rpc('void_payment', { p_payment_id: p.id, p_reason: reason }));
  }

  return (
    <div className="space-y-4">
      {canCreateOrder && (
        <div className="flex gap-2">
          <button
            onClick={() => setViewMode('bills')}
            className={`px-3 py-1.5 rounded text-xs font-semibold ${
              viewMode === 'bills' ? 'bg-primary text-primary-fg' : 'border border-border'
            }`}
          >
            Open bills{bills.length > 0 ? ` (${bills.length})` : ''}
          </button>
          <button
            onClick={() => setViewMode('new')}
            className={`px-3 py-1.5 rounded text-xs font-semibold ${
              viewMode === 'new' ? 'bg-primary text-primary-fg' : 'border border-border'
            }`}
          >
            + New order
          </button>
        </div>
      )}

      {viewMode === 'new' && canCreateOrder ? (
        <NewOrderPanel taxRateBps={taxRateBps} categories={menuCategories} items={menuItems} onPlaced={onOrderPlaced} />
      ) : bills.length === 0 ? (
        <div className="rounded-lg border border-border bg-surface p-10 text-center text-muted text-sm">
          No open bills.
        </div>
      ) : (
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
              {canPrintReceipt && (
                <button
                  onClick={() => printInvoice(bill, restaurantName, receipt)}
                  className="text-primary text-xs font-semibold underline"
                >
                  Print invoice
                </button>
              )}
              {canViewReceipt && (
                <button
                  onClick={() => downloadReceiptPdf(effectiveReceiptConfig(receipt), toReceiptContext(bill, restaurantName, receipt))}
                  className="text-primary text-xs font-semibold underline"
                >
                  Download PDF
                </button>
              )}
            </div>
          </div>

          <div className="space-y-1 text-xs mb-3">
            {bill.order_lines.map((l) => (
              <div key={l.id} className="flex justify-between gap-2">
                <span>
                  {l.qty}× {l.name_snapshot}
                </span>
                <span className="flex items-center gap-2">
                  {canOverridePrice && (
                    <button onClick={() => overridePrice(l)} disabled={busy} className="text-primary underline text-[11px]">
                      change price
                    </button>
                  )}
                  {formatCents(l.line_total_cents)}
                </span>
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

          {owed > 0 && canTakePayment && (
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
                    {canAdjustPayment && p.status !== 'voided' && (
                      <button onClick={() => adjustPayment(p)} className="text-primary underline">
                        correct
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

          {canRefund && refundThresholdCents != null && (
            <p className="mt-2 text-[11px] text-muted">
              {canApproveRefund
                ? `You can approve refunds above the ${formatCents(refundThresholdCents)} limit.`
                : `Refunds above ${formatCents(refundThresholdCents)} need someone with refund approval.`}
            </p>
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
      )}
    </div>
  );
}
