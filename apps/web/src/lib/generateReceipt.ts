import jsPDF from 'jspdf';
import { formatCents } from './format';

/**
 * One order's printed/PDF receipt — a dedicated, importable module so
 * Checkout (and any future call site, e.g. the storefront's own order
 * tracking page) shares one implementation instead of each inlining its
 * own layout, mirroring generateReport.ts's own single-module pattern.
 */
export type ReceiptData = {
  restaurantName: string;
  logoUrl?: string | null;
  orderNumber: number;
  tableLabel?: string | null;
  customerName?: string | null;
  createdAt: string;
  lines: { qty: number; name: string; totalCents: number }[];
  subtotalCents: number;
  discountCents?: number;
  taxCents: number;
  refundedCents?: number;
  totalCents: number;
  paidVia?: string | null;
  footerText?: string | null;
};

const WIDTH = 80; // mm — standard thermal-receipt width
const MARGIN = 5;
const CONTENT_W = WIDTH - MARGIN * 2;

export async function loadImage(url: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

/** Builds a real vector PDF (not a screenshot) sized like a till receipt. */
export async function buildReceiptDoc(data: ReceiptData): Promise<jsPDF> {
  // Height grows with line count — a fixed generous estimate, trimmed to
  // content afterward so the PDF isn't mostly blank space.
  const estHeight = 60 + data.lines.length * 5 + (data.footerText ? 10 : 0);
  const doc = new jsPDF({ unit: 'mm', format: [WIDTH, Math.max(estHeight, 100)] });
  let y = MARGIN;

  if (data.logoUrl) {
    const img = await loadImage(data.logoUrl);
    if (img) {
      const logoH = 14;
      const logoW = (img.width / img.height) * logoH;
      doc.addImage(img, 'PNG', (WIDTH - logoW) / 2, y, logoW, logoH);
      y += logoH + 3;
    }
  }

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(11);
  doc.text(data.restaurantName, WIDTH / 2, y, { align: 'center' });
  y += 5;

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8);
  const meta = [
    `Order #${data.orderNumber}`,
    data.tableLabel ?? null,
    data.customerName ?? null,
  ]
    .filter(Boolean)
    .join(' · ');
  doc.text(meta, WIDTH / 2, y, { align: 'center' });
  y += 4;
  doc.text(new Date(data.createdAt).toLocaleString(), WIDTH / 2, y, { align: 'center' });
  y += 4;

  doc.setLineDashPattern([0.8, 0.8], 0);
  doc.line(MARGIN, y, WIDTH - MARGIN, y);
  y += 4;

  doc.setFontSize(8.5);
  for (const l of data.lines) {
    const label = `${l.qty}x ${l.name}`;
    const priceStr = formatCents(l.totalCents);
    const wrapped = doc.splitTextToSize(label, CONTENT_W - 16);
    doc.text(wrapped, MARGIN, y);
    doc.text(priceStr, WIDTH - MARGIN, y, { align: 'right' });
    y += wrapped.length * 3.6 + 1;
  }

  y += 1;
  doc.line(MARGIN, y, WIDTH - MARGIN, y);
  y += 4;

  const row = (label: string, value: string, bold = false) => {
    doc.setFont('helvetica', bold ? 'bold' : 'normal');
    doc.text(label, MARGIN, y);
    doc.text(value, WIDTH - MARGIN, y, { align: 'right' });
    y += 4.2;
  };
  row('Subtotal', formatCents(data.subtotalCents));
  if (data.discountCents && data.discountCents > 0) row('Discount', `-${formatCents(data.discountCents)}`);
  row('Tax', formatCents(data.taxCents));
  if (data.refundedCents && data.refundedCents > 0) row('Refunded', `-${formatCents(data.refundedCents)}`);
  doc.setFontSize(10);
  row('TOTAL', formatCents(data.totalCents), true);
  doc.setFontSize(8.5);

  if (data.paidVia) {
    y += 1;
    doc.setFont('helvetica', 'normal');
    doc.text(`Paid via: ${data.paidVia}`, MARGIN, y);
    y += 5;
  }

  if (data.footerText) {
    y += 2;
    doc.line(MARGIN, y, WIDTH - MARGIN, y);
    y += 4;
    doc.setFontSize(7.5);
    doc.setTextColor(100, 116, 139);
    const lines = doc.splitTextToSize(data.footerText, CONTENT_W);
    doc.text(lines, WIDTH / 2, y, { align: 'center' });
    y += lines.length * 3.4;
  }

  return doc;
}

export async function downloadReceiptPdf(data: ReceiptData): Promise<void> {
  const doc = await buildReceiptDoc(data);
  doc.save(`receipt-${data.orderNumber}.pdf`);
}
