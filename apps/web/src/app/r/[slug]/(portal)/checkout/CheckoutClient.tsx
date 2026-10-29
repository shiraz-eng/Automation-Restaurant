'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import {
  ArrowLeft,
  Banknote,
  Check,
  ChevronRight,
  CreditCard,
  FileText,
  Plus,
  Printer,
  Download,
  ReceiptText,
  ShoppingBag,
  ShoppingCart,
  Smartphone,
  Tag,
  UtensilsCrossed,
  X,
} from 'lucide-react';
import styles from './checkout.module.css';
import { useRouter } from 'next/navigation';
import { usePortalSupabase, usePortal } from '@/components/PortalProvider';
import { Button, Input } from '@/components/ui';
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
  restaurant: {
    address: string | null;
    phone: string | null;
    email: string | null;
    website: string | null;
    taxId: string | null;
  };
};
export type NewOrderCategory = { id: string; name: string };
export type NewOrderItem = {
  id: string;
  name: string;
  category_id: string | null;
  menu_variants: {
    id: string;
    name: string;
    price_cents: number;
    sort_order: number;
    is_available: boolean;
    computed_available?: boolean;
  }[];
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
function toReceiptContext(
  bill: Bill,
  restaurantName: string,
  receipt: ReceiptSettings,
  paidViaOverride?: { method: string; amountCents: number },
): ReceiptContext {
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
      ? [
          {
            id: 'legacy-footer',
            text: receipt.footerText,
            align: 'center',
            bold: false,
          },
        ]
      : DEFAULT_RECEIPT_CONFIG.customText,
  };
}

const UNPAID = ['pending', 'in_kitchen', 'ready', 'served'];
const METHODS = ['cash', 'card', 'mobile'] as const;
/** Methods adjust_payment() accepts. */
const ADJUST_METHODS = ['cash', 'card', 'mobile', 'online', 'wallet', 'other'] as const;

function netPaid(b: Bill): number {
  return b.payments.filter((p) => p.status !== 'voided').reduce((s, p) => s + (p.amount_cents - p.refunded_cents), 0);
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
function printInvoice(
  bill: Bill,
  restaurantName: string,
  receipt: ReceiptSettings,
  paidViaOverride?: { method: string; amountCents: number },
  existingWindow?: Window | null,
) {
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
    const logoHtml = receipt.logoUrl
      ? `<img src="${esc(receipt.logoUrl)}" alt="" style="max-width:120px;max-height:60px;display:block;margin:0 auto 8px" />`
      : '';
    const linesHtml = bill.order_lines
      .map(
        (l) =>
          `<tr><td>${l.qty}&times; ${esc(l.name_snapshot)}</td><td class="right">${formatCents(l.line_total_cents)}</td></tr>`,
      )
      .join('');
    const discountRow =
      bill.discount_cents > 0
        ? `<tr><td>Discount</td><td class="right">&minus;${formatCents(bill.discount_cents)}</td></tr>`
        : '';
    const refundedRow =
      bill.refunded_cents > 0
        ? `<tr><td>Refunded</td><td class="right">&minus;${formatCents(bill.refunded_cents)}</td></tr>`
        : '';
    const footerHtml = receipt.footerText
      ? `<div class="muted" style="margin-top:8px">${esc(receipt.footerText)}</div>`
      : '';
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
  const { slug } = usePortal();
  const mutationLock = useRef(false);
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
  const change = method === 'cash' && tenderedCents != null ? tenderedCents - amountCents : null;

  async function run(fn: () => PromiseLike<{ error: { message: string } | null }>, ok?: string): Promise<boolean> {
    if (mutationLock.current) return false;
    mutationLock.current = true;
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const { error: e } = await fn();
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
    } catch {
      setError('Unable to confirm the result. Refresh the bill before trying again.');
      return false;
    } finally {
      mutationLock.current = false;
      setBusy(false);
    }
  }

  async function takePayment() {
    if (
      !bill ||
      mutationLock.current ||
      !Number.isFinite(amountCents) ||
      amountCents <= 0 ||
      amountCents > owed ||
      (method === 'cash' && tenderedCents != null && (!Number.isFinite(tenderedCents) || tenderedCents < amountCents))
    )
      return;
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
      () =>
        supabase.rpc('override_line_price', {
          p_line_id: line.id,
          p_unit_price_cents: cents,
          p_reason: reason,
        }),
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
      () =>
        supabase.rpc('adjust_payment', {
          p_payment_id: p.id,
          p_method: method,
          p_reference: ref,
          p_reason: reason,
        }),
      'Payment corrected.',
    );
  }

  async function voidPay(p: Pay) {
    const reason = window.prompt('Reason for voiding this payment:');
    if (!reason) return;
    await run(() => supabase.rpc('void_payment', { p_payment_id: p.id, p_reason: reason }));
  }

  const invalidAmount = !Number.isFinite(amountCents) || amountCents <= 0 || amountCents > owed;
  const invalidCash =
    method === 'cash' && tenderedCents != null && (!Number.isFinite(tenderedCents) || tenderedCents < amountCents);

  return (
    <div className={styles.checkout} aria-busy={busy}>
      <header className={styles.header}>
        <div>
          <Link href={`/r/${slug}/orders`} className={styles.back}>
            <ArrowLeft size={18} /> Back to Orders
          </Link>
          <h1>Checkout</h1>
          <p className="text-muted text-sm">Review your order and complete the payment.</p>
        </div>
        {bill && (
          <div className={styles.tableBadge}>
            <span className={styles.icon}>
              <UtensilsCrossed size={26} />
            </span>
            <div>
              <strong>{bill.table_label || `Order #${bill.order_number}`}</strong>
              <p className="text-muted text-xs mt-1 capitalize">
                {bill.channel.replaceAll('_', ' ')} · {bill.status.replaceAll('_', ' ')}
              </p>
            </div>
          </div>
        )}
      </header>
      <div role="status" aria-live="polite">
        {note && <p className={styles.success}>{note}</p>}
      </div>
      {error && (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      )}
      {viewMode === 'new' && canCreateOrder ? (
        <div className="space-y-4">
          <Button variant="ghost" onClick={() => setViewMode('bills')} disabled={busy}>
            <ArrowLeft size={16} /> Active bills ({bills.length})
          </Button>
          <NewOrderPanel
            taxRateBps={taxRateBps}
            categories={menuCategories}
            items={menuItems}
            onPlaced={onOrderPlaced}
          />
        </div>
      ) : (
        <div className={styles.columns}>
          <div className="min-w-0 space-y-5">
            <section className={styles.card} aria-labelledby="checkout-items">
              <div className={styles.sectionHeading}>
                <h2 id="checkout-items">
                  <ShoppingCart /> Order Items
                </h2>
                {bill && <span className={styles.pill}>{bill.order_lines.reduce((n, l) => n + l.qty, 0)} items</span>}
              </div>
              {bill ? (
                bill.order_lines.map((l) => (
                  <div key={l.id} className={styles.item}>
                    <span className={styles.productIcon}>
                      <UtensilsCrossed size={26} />
                    </span>
                    <div className="min-w-0 flex-1">
                      <h3 className="font-bold text-sm">{l.name_snapshot}</h3>
                      {l.variant_name_snapshot && <p className="text-muted text-xs mt-1">{l.variant_name_snapshot}</p>}
                      {l.modifiers?.length > 0 && (
                        <p className="text-muted text-xs mt-1">{l.modifiers.map((m) => m.name).join(', ')}</p>
                      )}
                      {l.customer_note && (
                        <p className="text-muted text-xs mt-2 break-words">Note: {l.customer_note}</p>
                      )}
                    </div>
                    <span className={styles.quantity} aria-label={`Quantity ${l.qty}`}>
                      {l.qty}×
                    </span>
                    <strong className="text-sm tabular-nums">{formatCents(l.line_total_cents)}</strong>
                  </div>
                ))
              ) : (
                <p className="py-10 text-center text-muted text-sm">Select a bill to review its items.</p>
              )}
            </section>
            <section className={styles.card} aria-labelledby="checkout-bills">
              <div className={styles.sectionHeading}>
                <div>
                  <h2 id="checkout-bills">
                    <ReceiptText /> Active Bills
                  </h2>
                  <p className="text-muted text-xs mt-2">Open a bill, take payment, or issue a refund.</p>
                </div>
                {canCreateOrder && (
                  <Button variant="ghost" onClick={() => setViewMode('new')} disabled={busy} className={styles.outline}>
                    <Plus size={16} /> New order
                  </Button>
                )}
              </div>
              <div className="space-y-3">
                {bills.map((b) => (
                  <button
                    key={b.id}
                    disabled={busy}
                    aria-pressed={open === b.id}
                    onClick={() => {
                      setOpen(b.id);
                      setAmount('');
                      setTendered('');
                      setError(null);
                      setNote(null);
                    }}
                    className={`${styles.bill} ${open === b.id ? styles.selected : ''}`}
                  >
                    <span className={styles.icon}>
                      <ShoppingBag size={21} />
                    </span>
                    <span className="flex-1 min-w-0 text-start">
                      <strong className="text-sm">{b.table_label || `Order #${b.order_number}`}</strong>
                      <span className="block text-muted text-xs mt-1 capitalize">
                        #{b.order_number} · {b.status.replaceAll('_', ' ')} ·{' '}
                        {b.order_lines.reduce((n, l) => n + l.qty, 0)} items
                      </span>
                    </span>
                    <strong className="text-sm tabular-nums">{due(b) === 0 ? 'Paid' : formatCents(due(b))}</strong>
                    <ChevronRight size={18} className="text-muted shrink-0" />
                  </button>
                ))}
                {bills.length === 0 && <p className="py-6 text-muted text-sm text-center">No open bills.</p>}
              </div>
            </section>
          </div>
          {bill && (
            <section className={`${styles.card} ${styles.summary}`} aria-labelledby="checkout-summary">
              <div className={styles.sectionHeading}>
                <h2 id="checkout-summary">
                  <FileText /> Order Summary
                </h2>
                <span className="text-xs font-bold">Order #{bill.order_number}</span>
              </div>
              <div className="space-y-4 pb-5">
                {bill.order_lines.map((l) => (
                  <div key={l.id} className="flex items-start gap-3">
                    <span className={styles.quantity}>{l.qty}×</span>
                    <div className="flex-1 min-w-0">
                      <p className="text-xs font-semibold">
                        {l.name_snapshot}
                        {l.variant_name_snapshot ? ` · ${l.variant_name_snapshot}` : ''}
                      </p>
                      {canOverridePrice && (
                        <button
                          onClick={() => overridePrice(l)}
                          disabled={busy}
                          className="text-primary text-xs underline mt-1"
                        >
                          Change price
                        </button>
                      )}
                    </div>
                    <strong className="text-xs tabular-nums">{formatCents(l.line_total_cents)}</strong>
                  </div>
                ))}
              </div>
              <dl className={styles.totals}>
                <div>
                  <dt>Subtotal</dt>
                  <dd>{formatCents(bill.subtotal_cents)}</dd>
                </div>
                {bill.discount_cents > 0 && (
                  <div>
                    <dt>Discount</dt>
                    <dd>−{formatCents(bill.discount_cents)}</dd>
                  </div>
                )}
                <div>
                  <dt>Tax ({bill.tax_rate_bps / 100}%)</dt>
                  <dd>{formatCents(bill.tax_cents)}</dd>
                </div>
                {bill.refunded_cents > 0 && (
                  <div>
                    <dt>Refunded</dt>
                    <dd>−{formatCents(bill.refunded_cents)}</dd>
                  </div>
                )}
                <div className={styles.total}>
                  <dt>Total Amount</dt>
                  <dd>{formatCents(bill.total_cents)}</dd>
                </div>
                {netPaid(bill) !== 0 && (
                  <div>
                    <dt>Net payments</dt>
                    <dd>{formatCents(netPaid(bill))}</dd>
                  </div>
                )}
              </dl>
              <div className={styles.payment}>
                <h2>
                  <CreditCard /> Payment Method
                </h2>
                {owed > 0 && canTakePayment ? (
                  <>
                    <div className={styles.methods}>
                      {METHODS.map((m) => {
                        const Icon = m === 'cash' ? Banknote : m === 'card' ? CreditCard : Smartphone;
                        return (
                          <button
                            key={m}
                            aria-pressed={method === m}
                            disabled={busy}
                            onClick={() => setMethod(m)}
                            className={method === m ? styles.selected : ''}
                          >
                            <Icon size={24} />
                            {method === m && <Check size={14} className={styles.check} />}
                            <strong className="capitalize">{m}</strong>
                            <span>
                              {m === 'cash' ? 'Pay with cash' : m === 'card' ? 'Debit / Credit' : 'Mobile payment'}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                    <div className={styles.amountDue}>
                      <span>Amount due</span>
                      <strong>{formatCents(owed)}</strong>
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-4">
                      <label className="text-xs text-muted">
                        Payment amount
                        <Input
                          inputMode="decimal"
                          value={amount}
                          disabled={busy}
                          placeholder={(owed / 100).toFixed(2)}
                          onChange={(e) => setAmount(e.target.value)}
                          aria-invalid={invalidAmount}
                        />
                      </label>
                      {method === 'cash' && (
                        <label className="text-xs text-muted">
                          Cash tendered
                          <Input
                            inputMode="decimal"
                            value={tendered}
                            disabled={busy}
                            placeholder="Enter amount"
                            onChange={(e) => setTendered(e.target.value)}
                            aria-invalid={invalidCash}
                          />
                        </label>
                      )}
                    </div>
                    {invalidAmount && (
                      <p className="text-danger text-xs mt-2" role="alert">
                        Enter an amount greater than zero and no more than the amount due.
                      </p>
                    )}
                    {change != null && (
                      <p
                        role="status"
                        className={`text-xs font-semibold mt-3 ${invalidCash ? 'text-danger' : 'text-ok'}`}
                      >
                        {Number.isFinite(change)
                          ? `${change < 0 ? 'Short' : 'Change'} ${formatCents(Math.abs(change))}`
                          : 'Enter a valid cash amount.'}
                      </p>
                    )}
                    {method === 'cash' && !invalidAmount && (
                      <div className={styles.quickAmounts}>
                        {Array.from(
                          new Set([
                            amountCents,
                            Math.ceil(amountCents / 50000) * 50000,
                            Math.ceil(amountCents / 100000) * 100000,
                          ]),
                        )
                          .filter((v) => v > 0)
                          .map((v) => (
                            <button key={v} disabled={busy} onClick={() => setTendered((v / 100).toFixed(2))}>
                              {formatCents(v)}
                            </button>
                          ))}
                      </div>
                    )}
                    <Button
                      className={styles.payButton}
                      disabled={busy || invalidAmount || invalidCash}
                      onClick={takePayment}
                    >
                      <ReceiptText size={18} />
                      {busy
                        ? 'Working…'
                        : `Take Payment — ${formatCents(Number.isFinite(amountCents) ? amountCents : 0)}`}
                    </Button>
                  </>
                ) : (
                  <p className="text-sm text-muted py-4">
                    {owed === 0 ? 'This bill is fully paid.' : 'You do not have permission to accept payments.'}
                  </p>
                )}
                {bill.payments.length > 0 && (
                  <div className="mt-4 border-t border-border pt-2 space-y-1">
                    <div className="text-[0.625rem] uppercase tracking-wide text-muted font-bold">Payments</div>
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
                            <button disabled={busy} onClick={() => refund(p)} className="text-primary underline">
                              refund
                            </button>
                          )}
                          {canAdjustPayment && p.status !== 'voided' && (
                            <button disabled={busy} onClick={() => adjustPayment(p)} className="text-primary underline">
                              correct
                            </button>
                          )}
                          {canVoid && p.status === 'captured' && p.refunded_cents === 0 && (
                            <button disabled={busy} onClick={() => voidPay(p)} className="text-danger underline">
                              void
                            </button>
                          )}
                        </span>
                      </div>
                    ))}
                  </div>
                )}

                {canRefund && refundThresholdCents != null && (
                  <p className="mt-2 text-[0.6875rem] text-muted">
                    {canApproveRefund
                      ? `You can approve refunds above the ${formatCents(refundThresholdCents)} limit.`
                      : `Refunds above ${formatCents(refundThresholdCents)} need someone with refund approval.`}
                  </p>
                )}

                <div className="mt-5 flex justify-between gap-3 flex-wrap">
                  {canDiscount && (
                    <Button variant="ghost" onClick={discount} disabled={busy}>
                      <Tag size={16} /> Discount
                    </Button>
                  )}
                  {canCancel && bill.status !== 'void' && due(bill) === bill.total_cents - bill.refunded_cents && (
                    <Button variant="danger" onClick={cancel} disabled={busy}>
                      <X size={16} /> Cancel order
                    </Button>
                  )}
                </div>
              </div>
              {(canPrintReceipt || canViewReceipt) && (
                <div className={styles.receipts}>
                  {canPrintReceipt && (
                    <button onClick={() => printInvoice(bill, restaurantName, receipt)}>
                      <Printer size={16} /> Print invoice
                    </button>
                  )}
                  {canViewReceipt && (
                    <button
                      onClick={() =>
                        downloadReceiptPdf(
                          effectiveReceiptConfig(receipt),
                          toReceiptContext(bill, restaurantName, receipt),
                        )
                      }
                    >
                      <Download size={16} /> Download PDF
                    </button>
                  )}
                </div>
              )}
            </section>
          )}
        </div>
      )}
    </div>
  );
}
