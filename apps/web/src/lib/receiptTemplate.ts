import { formatCents } from './format';

/**
 * The restaurant's configurable receipt template (business_settings.
 * receipt_config) plus the pure function that turns it + one order's
 * authoritative data into a renderer-agnostic list of ReceiptBlocks.
 *
 * This is the ONE place that decides what a receipt contains and in what
 * order — generateReceipt.ts (PDF), CheckoutClient's print path, and the
 * Brand Kit settings page's live preview all walk the SAME block list
 * instead of each re-implementing "what goes on a receipt" (spec: "do not
 * create separate formatting logic for each output"). Nothing here
 * computes a price, tax, or total — every number comes in already
 * decided by the order/payment system (RULE: presentation only).
 */

export type Align = 'left' | 'center' | 'right';
export type DividerStyle = 'dashed' | 'solid' | 'double' | 'space';
export type LogoSize = 'sm' | 'md' | 'lg';

export type ReceiptSectionId =
  | 'header'
  | 'restaurant_info'
  | 'order_info'
  | 'items'
  | 'discount'
  | 'totals'
  | 'payment'
  | 'order_status'
  | 'custom_text';

export const ALL_SECTIONS: { id: ReceiptSectionId; label: string }[] = [
  { id: 'header', label: 'Header (logo & name)' },
  { id: 'restaurant_info', label: 'Restaurant information' },
  { id: 'order_info', label: 'Order information' },
  { id: 'items', label: 'Items' },
  { id: 'discount', label: 'Discount' },
  { id: 'totals', label: 'Totals & tax' },
  { id: 'payment', label: 'Payment' },
  { id: 'order_status', label: 'Order status' },
  { id: 'custom_text', label: 'Custom text' },
];

export type CustomTextBlock = { id: string; text: string; align: Align; bold: boolean };

export type ReceiptConfig = {
  width: '58mm' | '80mm';
  dividerStyle: DividerStyle;
  /** Which sections appear, and in what order. A section absent from this
   *  array is disabled — omission IS the visibility toggle. */
  sectionOrder: ReceiptSectionId[];
  header: {
    showLogo: boolean;
    logoSize: LogoSize;
    logoAlign: Align;
    nameAlign: Align;
    tagline: string;
    welcomeMessage: string;
  };
  restaurantInfo: {
    showAddress: boolean;
    showPhone: boolean;
    showEmail: boolean;
    showWebsite: boolean;
    showTaxId: boolean;
  };
  orderInfo: {
    showOrderNumber: boolean;
    showDate: boolean;
    showTime: boolean;
    showTable: boolean;
    showCustomer: boolean;
    showOrderType: boolean;
  };
  items: {
    showVariant: boolean;
    showModifiers: boolean;
    showNotes: boolean;
  };
  discount: { show: boolean; label: string };
  totals: { showSubtotal: boolean; showTax: boolean; taxLabel: string; showTotal: boolean };
  payment: { showMethod: boolean; showAmountPaid: boolean; showChange: boolean; showReference: boolean };
  orderStatus: { showStatus: boolean; showClosedAt: boolean };
  customText: CustomTextBlock[];
};

export const DEFAULT_RECEIPT_CONFIG: ReceiptConfig = {
  width: '80mm',
  dividerStyle: 'dashed',
  sectionOrder: ['header', 'restaurant_info', 'order_info', 'items', 'discount', 'totals', 'payment', 'custom_text'],
  header: { showLogo: true, logoSize: 'md', logoAlign: 'center', nameAlign: 'center', tagline: '', welcomeMessage: '' },
  restaurantInfo: { showAddress: true, showPhone: true, showEmail: false, showWebsite: false, showTaxId: false },
  orderInfo: { showOrderNumber: true, showDate: true, showTime: true, showTable: true, showCustomer: true, showOrderType: false },
  items: { showVariant: true, showModifiers: true, showNotes: true },
  discount: { show: true, label: 'Discount' },
  totals: { showSubtotal: true, showTax: true, taxLabel: 'Tax', showTotal: true },
  payment: { showMethod: true, showAmountPaid: true, showChange: true, showReference: false },
  orderStatus: { showStatus: false, showClosedAt: false },
  customText: [{ id: 'default-thanks', text: 'Thank you for visiting!', align: 'center', bold: false }],
};

/** Only these variables may be substituted into a custom text block —
 *  the safe, explicit set (RULE: do not expose arbitrary database
 *  fields). Plain string substitution only, exactly like the existing
 *  receipt_template_html mechanism — never evaluated as code. */
export const RECEIPT_VARIABLES = [
  'restaurant_name', 'order_number', 'order_date', 'order_time', 'customer_name',
  'table_number', 'subtotal', 'tax', 'total', 'payment_method', 'amount_paid', 'change_due',
] as const;

export type ReceiptItemLine = {
  qty: number;
  name: string;
  variantName?: string | null;
  modifiers?: { name: string; price_cents: number }[];
  notes?: string | null;
  unitPriceCents: number;
  lineTotalCents: number;
};

/** Everything a receipt needs, already authoritative — sourced from
 *  orders/order_lines/payments/business_settings, never recomputed here. */
export type ReceiptContext = {
  restaurantName: string;
  logoUrl: string | null;
  address: string | null;
  phone: string | null;
  email: string | null;
  website: string | null;
  taxId: string | null;
  orderNumber: number;
  tableLabel: string | null;
  customerName: string | null;
  orderType: string | null;
  createdAt: string;
  paidAt: string | null;
  orderStatus: string | null;
  lines: ReceiptItemLine[];
  subtotalCents: number;
  discountCents: number;
  taxCents: number;
  taxRateBps: number;
  totalCents: number;
  refundedCents: number;
  paymentMethod: string | null;
  paymentReference: string | null;
  amountPaidCents: number | null;
  changeCents: number | null;
};

export type ReceiptBlock =
  | { type: 'logo'; url: string; size: LogoSize; align: Align }
  | { type: 'text'; text: string; align: Align; bold?: boolean; size?: 'sm' | 'normal' | 'lg'; muted?: boolean }
  | { type: 'divider'; style: DividerStyle }
  | { type: 'row'; label: string; value: string; bold?: boolean }
  | { type: 'item'; qty: number; name: string; total: string; sub: string[] }
  | { type: 'space' };

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric' });
}
function fmtTime(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

function substitute(text: string, ctx: ReceiptContext): string {
  const vars: Record<string, string> = {
    restaurant_name: ctx.restaurantName,
    order_number: String(ctx.orderNumber),
    order_date: fmtDate(ctx.createdAt),
    order_time: fmtTime(ctx.createdAt),
    customer_name: ctx.customerName ?? '',
    table_number: ctx.tableLabel ?? '',
    subtotal: formatCents(ctx.subtotalCents),
    tax: formatCents(ctx.taxCents),
    total: formatCents(ctx.totalCents),
    payment_method: ctx.paymentMethod ?? '',
    amount_paid: ctx.amountPaidCents != null ? formatCents(ctx.amountPaidCents) : '',
    change_due: ctx.changeCents != null ? formatCents(ctx.changeCents) : '',
  };
  return text.replace(/\{([a-z_]+)\}/gi, (m, key: string) => vars[key.toLowerCase()] ?? m);
}

/** Pure: config + authoritative order data -> an ordered list of blocks.
 *  No I/O, no calculation — every number already arrived decided. */
export function buildReceiptBlocks(config: ReceiptConfig, ctx: ReceiptContext): ReceiptBlock[] {
  const blocks: ReceiptBlock[] = [];
  const divider = () => blocks.push({ type: 'divider', style: config.dividerStyle });

  for (const section of config.sectionOrder) {
    switch (section) {
      case 'header': {
        const h = config.header;
        if (h.showLogo && ctx.logoUrl) blocks.push({ type: 'logo', url: ctx.logoUrl, size: h.logoSize, align: h.logoAlign });
        blocks.push({ type: 'text', text: ctx.restaurantName, align: h.nameAlign, bold: true, size: 'lg' });
        if (h.tagline.trim()) blocks.push({ type: 'text', text: h.tagline.trim(), align: h.nameAlign, size: 'sm', muted: true });
        if (h.welcomeMessage.trim()) blocks.push({ type: 'text', text: h.welcomeMessage.trim(), align: h.nameAlign, size: 'sm' });
        break;
      }
      case 'restaurant_info': {
        const r = config.restaurantInfo;
        const lines = [
          r.showAddress && ctx.address,
          r.showPhone && ctx.phone,
          r.showEmail && ctx.email,
          r.showWebsite && ctx.website,
          r.showTaxId && ctx.taxId && `Tax Reg: ${ctx.taxId}`,
        ].filter((v): v is string => !!v);
        if (lines.length) {
          divider();
          for (const line of lines) blocks.push({ type: 'text', text: line, align: 'center', size: 'sm' });
        }
        break;
      }
      case 'order_info': {
        const o = config.orderInfo;
        const metaBits = [
          o.showOrderNumber && `Order #${ctx.orderNumber}`,
          o.showTable && ctx.tableLabel,
          o.showCustomer && ctx.customerName,
          o.showOrderType && ctx.orderType,
        ].filter((v): v is string => !!v);
        const dateBits = [o.showDate && fmtDate(ctx.createdAt), o.showTime && fmtTime(ctx.createdAt)]
          .filter((v): v is string => !!v)
          .join(' ');
        if (metaBits.length || dateBits) {
          divider();
          if (metaBits.length) blocks.push({ type: 'text', text: metaBits.join(' · '), align: 'left', size: 'sm' });
          if (dateBits) blocks.push({ type: 'text', text: dateBits, align: 'left', size: 'sm', muted: true });
        }
        break;
      }
      case 'items': {
        if (!ctx.lines.length) break;
        divider();
        for (const l of ctx.lines) {
          const sub: string[] = [];
          if (config.items.showVariant && l.variantName) sub.push(l.variantName);
          if (config.items.showModifiers) for (const m of l.modifiers ?? []) sub.push(m.price_cents ? `${m.name} ${formatCents(m.price_cents)}` : m.name);
          if (config.items.showNotes && l.notes) sub.push(l.notes);
          blocks.push({ type: 'item', qty: l.qty, name: l.name, total: formatCents(l.lineTotalCents), sub });
        }
        break;
      }
      case 'discount': {
        if (config.discount.show && ctx.discountCents > 0) {
          divider();
          blocks.push({ type: 'row', label: config.discount.label, value: `-${formatCents(ctx.discountCents)}` });
        }
        break;
      }
      case 'totals': {
        const t = config.totals;
        divider();
        if (t.showSubtotal) blocks.push({ type: 'row', label: 'Subtotal', value: formatCents(ctx.subtotalCents) });
        if (t.showTax) {
          const pct = ctx.taxRateBps > 0 ? ` ${(ctx.taxRateBps / 100).toFixed(ctx.taxRateBps % 100 === 0 ? 0 : 1)}%` : '';
          blocks.push({ type: 'row', label: `${t.taxLabel}${pct}`, value: formatCents(ctx.taxCents) });
        }
        if (ctx.refundedCents > 0) blocks.push({ type: 'row', label: 'Refunded', value: `-${formatCents(ctx.refundedCents)}` });
        if (t.showTotal) blocks.push({ type: 'row', label: 'TOTAL', value: formatCents(ctx.totalCents), bold: true });
        break;
      }
      case 'payment': {
        const p = config.payment;
        const rows: { label: string; value: string; bold?: boolean }[] = [];
        if (p.showMethod && ctx.paymentMethod) rows.push({ label: ctx.paymentMethod.toUpperCase(), value: ctx.amountPaidCents != null ? formatCents(ctx.amountPaidCents) : '' });
        if (p.showReference && ctx.paymentReference) rows.push({ label: 'Ref', value: ctx.paymentReference });
        if (p.showChange && ctx.changeCents != null && ctx.changeCents > 0) rows.push({ label: 'Change Due', value: formatCents(ctx.changeCents), bold: true });
        if (rows.length) {
          divider();
          for (const r of rows) blocks.push({ type: 'row', ...r });
        }
        break;
      }
      case 'order_status': {
        const s = config.orderStatus;
        const lines = [s.showStatus && ctx.orderStatus, s.showClosedAt && ctx.paidAt && fmtDate(ctx.paidAt) + ' ' + fmtTime(ctx.paidAt)].filter(
          (v): v is string => !!v,
        );
        if (lines.length) {
          divider();
          for (const line of lines) blocks.push({ type: 'text', text: line, align: 'center', size: 'sm' });
        }
        break;
      }
      case 'custom_text': {
        if (config.customText.length) {
          divider();
          for (const c of config.customText) {
            if (!c.text.trim()) continue;
            blocks.push({ type: 'text', text: substitute(c.text, ctx), align: c.align, bold: c.bold, size: 'sm' });
          }
        }
        break;
      }
    }
  }

  return blocks;
}
