import jsPDF from 'jspdf';

/**
 * KOT (Kitchen Order Ticket) print — a dedicated, minimal PDF for the
 * kitchen printer, deliberately separate from generateReceipt.ts's
 * customer receipt: no prices/totals/payment info, larger monospace type
 * for at-a-glance scanning, item/variant/modifier/note only. Sized like a
 * thermal ticket (80mm), same jsPDF-draws-a-ReceiptBlock-list convention
 * generateReceipt.ts established, simplified since a KOT has no
 * restaurant-configurable template (receipt_config) — its shape is fixed.
 */

export type KotTicketLine = {
  qty: number;
  name: string;
  variantName?: string | null;
  modifiers?: string[];
  note?: string | null;
};
export type KotTicketData = {
  restaurantName: string;
  kotNumber: number;
  orderNumber: number;
  channel: string;
  tableLabel?: string | null;
  createdAt: string;
  lines: KotTicketLine[];
  orderNote?: string | null;
};

const WIDTH = 80;
const MARGIN = 5;
const X_LEFT = MARGIN;
const X_CENTER = WIDTH / 2;

export function buildKotTicketDoc(data: KotTicketData): jsPDF {
  let h = 45;
  for (const l of data.lines) h += 7 + (l.variantName ? 4 : 0) + (l.modifiers?.length ?? 0) * 4 + (l.note ? 4 : 0);
  if (data.orderNote) h += 10;
  h += 14; // "KITCHEN COPY" footer

  const doc = new jsPDF({ unit: 'mm', format: [WIDTH, h] });
  let y = 8;

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(12);
  doc.text(data.restaurantName.toUpperCase(), X_CENTER, y, { align: 'center' });
  y += 7;

  doc.setFontSize(14);
  doc.text(`KOT #${data.kotNumber}`, X_CENTER, y, { align: 'center' });
  y += 5.5;
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  doc.text(`ORDER #${data.orderNumber}`, X_CENTER, y, { align: 'center' });
  y += 5;

  const typeLine = [data.tableLabel ? `TABLE ${data.tableLabel}` : null, data.channel.replace('_', ' ').toUpperCase()].filter(Boolean).join(' · ');
  doc.setFont('helvetica', 'bold');
  doc.text(typeLine, X_CENTER, y, { align: 'center' });
  y += 5;
  doc.setFont('helvetica', 'normal');
  doc.text(new Date(data.createdAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }), X_CENTER, y, { align: 'center' });
  y += 4;

  doc.setLineWidth(0.3);
  doc.line(X_LEFT, y, WIDTH - MARGIN, y);
  y += 6;

  for (const l of data.lines) {
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(11);
    const text = doc.splitTextToSize(`${l.qty} × ${l.name.toUpperCase()}`, WIDTH - MARGIN * 2);
    doc.text(text, X_LEFT, y);
    y += text.length * 4.5 + 1.5;

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9);
    if (l.variantName) {
      doc.text(l.variantName.toUpperCase(), X_LEFT + 3, y);
      y += 4;
    }
    for (const m of l.modifiers ?? []) {
      doc.text(m.toUpperCase(), X_LEFT + 3, y);
      y += 4;
    }
    if (l.note) {
      doc.setFont('helvetica', 'bolditalic');
      doc.text(`* ${l.note}`, X_LEFT + 3, y);
      doc.setFont('helvetica', 'normal');
      y += 4;
    }
    y += 2;
  }

  doc.setLineWidth(0.3);
  doc.line(X_LEFT, y, WIDTH - MARGIN, y);
  y += 5;

  if (data.orderNote) {
    doc.setFont('helvetica', 'bolditalic');
    doc.setFontSize(10);
    const text = doc.splitTextToSize(data.orderNote.toUpperCase(), WIDTH - MARGIN * 2);
    doc.text(text, X_CENTER, y, { align: 'center' });
    y += text.length * 4.5 + 3;
    doc.setLineWidth(0.3);
    doc.line(X_LEFT, y, WIDTH - MARGIN, y);
    y += 5;
  }

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(9);
  doc.text('KITCHEN COPY', X_CENTER, y, { align: 'center' });

  return doc;
}

export function downloadKotTicket(data: KotTicketData): void {
  buildKotTicketDoc(data).save(`kot-${data.kotNumber}.pdf`);
}

/** Convenience adapter from a KOT board's Kot shape to KotTicketData —
 *  kept here (not in kitchenTypes.ts) since it's presentation glue, not a
 *  data-model helper. */
export function printKotTicket(
  restaurantName: string,
  kot: {
    order_number: number;
    channel: string;
    table_label: string | null;
    created_at: string;
    customer_note: string | null;
    order_lines: { qty: number; name_snapshot: string; variant_name_snapshot: string | null; modifiers: { name: string }[] | null; customer_note: string | null }[];
  },
): void {
  downloadKotTicket({
    restaurantName,
    kotNumber: kot.order_number,
    orderNumber: kot.order_number,
    channel: kot.channel,
    tableLabel: kot.table_label,
    createdAt: kot.created_at,
    orderNote: kot.customer_note,
    lines: kot.order_lines.map((l) => ({
      qty: l.qty,
      name: l.name_snapshot,
      variantName: l.variant_name_snapshot,
      modifiers: (l.modifiers ?? []).map((m) => m.name),
      note: l.customer_note,
    })),
  });
}
