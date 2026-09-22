import jsPDF from 'jspdf';
import type { ReceiptBlock, ReceiptConfig, ReceiptContext } from './receiptTemplate';
import { buildReceiptBlocks } from './receiptTemplate';

/**
 * One order's printed/PDF receipt — a dedicated, importable module so
 * Checkout (and any future call site, e.g. the storefront's own order
 * tracking page) shares one implementation instead of each inlining its
 * own layout, mirroring generateReport.ts's own single-module pattern.
 *
 * Draws the SAME ReceiptBlock list buildReceiptBlocks() produces from the
 * restaurant's receipt_config — this file only knows how to put a block on
 * a page with jsPDF, never what belongs on the receipt or what any number
 * is (RULE: presentation only, financial data stays authoritative).
 */

const LOGO_MM: Record<'sm' | 'md' | 'lg', number> = { sm: 10, md: 14, lg: 18 };

/** "124 58 237" -> [124, 58, 237]. Falls back to near-black (matches this
 *  file's existing default body color) for an unset/malformed value. */
function parseChannels(channels: string | null | undefined): [number, number, number] {
  if (channels) {
    const parts = channels.trim().split(/\s+/).map(Number);
    if (parts.length === 3 && parts.every((n) => !Number.isNaN(n))) return parts as [number, number, number];
  }
  return [17, 17, 17];
}

export async function loadImage(url: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

function estimateHeight(blocks: ReceiptBlock[]): number {
  let h = 20;
  for (const b of blocks) {
    if (b.type === 'logo') h += LOGO_MM[b.size] + 3;
    else if (b.type === 'item') h += 4 + (b.sub?.length ?? 0) * 3.4;
    else if (b.type === 'divider') h += b.style === 'space' ? 3 : 4;
    else if (b.type === 'space') h += 3;
    else h += 4.2;
  }
  return h;
}

/** Builds a real vector PDF (not a screenshot) sized like a till receipt,
 *  from the restaurant's receipt_config and one order's authoritative data. */
export async function buildReceiptDoc(config: ReceiptConfig, ctx: ReceiptContext): Promise<jsPDF> {
  const blocks = buildReceiptBlocks(config, ctx);
  const WIDTH = config.width === '58mm' ? 58 : 80;
  const MARGIN = config.width === '58mm' ? 3 : 5;
  const CONTENT_W = WIDTH - MARGIN * 2;
  const X = { left: MARGIN, center: WIDTH / 2, right: WIDTH - MARGIN } as const;
  const accent = parseChannels(ctx.primaryColor);

  const doc = new jsPDF({ unit: 'mm', format: [WIDTH, Math.max(estimateHeight(blocks), 90)] });
  let y = MARGIN;

  for (const b of blocks) {
    switch (b.type) {
      case 'logo': {
        const img = await loadImage(b.url);
        if (img) {
          const logoH = LOGO_MM[b.size];
          const logoW = (img.width / img.height) * logoH;
          const x = b.align === 'center' ? (WIDTH - logoW) / 2 : b.align === 'right' ? WIDTH - MARGIN - logoW : MARGIN;
          doc.addImage(img, 'PNG', x, y, logoW, logoH);
          y += logoH + 3;
        }
        break;
      }
      case 'text': {
        doc.setFont('helvetica', b.bold ? 'bold' : 'normal');
        doc.setFontSize(b.size === 'lg' ? 11 : b.size === 'sm' ? 7.5 : 8.5);
        if (b.muted) doc.setTextColor(100, 116, 139);
        else doc.setTextColor(17, 17, 17);
        const wrapped = doc.splitTextToSize(b.text, CONTENT_W);
        doc.text(wrapped, X[b.align], y, { align: b.align });
        y += wrapped.length * (b.size === 'lg' ? 4.6 : 3.6) + 1;
        break;
      }
      case 'divider': {
        if (b.style === 'space') {
          y += 3;
          break;
        }
        doc.setDrawColor(0, 0, 0);
        doc.setLineDashPattern(b.style === 'dashed' ? [0.8, 0.8] : [], 0);
        doc.setLineWidth(b.style === 'double' ? 0.6 : 0.2);
        doc.line(MARGIN, y, WIDTH - MARGIN, y);
        y += 4;
        break;
      }
      case 'row': {
        const isTotal = b.label === 'TOTAL' && b.bold;
        doc.setFont('helvetica', b.bold ? 'bold' : 'normal');
        doc.setFontSize(b.bold ? 10 : 8.5);
        if (isTotal) doc.setTextColor(...accent);
        else doc.setTextColor(17, 17, 17);
        doc.text(b.label, MARGIN, y);
        doc.text(b.value, WIDTH - MARGIN, y, { align: 'right' });
        y += 4.4;
        break;
      }
      case 'item': {
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(8.5);
        doc.setTextColor(17, 17, 17);
        const label = `${b.qty}x ${b.name}`;
        // Leave room for the total column so a long name wraps onto its
        // own line(s) rather than colliding with the price (spec: long
        // product names must not overflow the thermal width).
        const wrapped = doc.splitTextToSize(label, CONTENT_W - 16);
        doc.text(wrapped, MARGIN, y);
        doc.text(b.total, WIDTH - MARGIN, y, { align: 'right' });
        y += wrapped.length * 3.6;
        doc.setFontSize(7.5);
        doc.setTextColor(90, 90, 90);
        for (const s of b.sub) {
          const subWrapped = doc.splitTextToSize(s, CONTENT_W - 6);
          doc.text(subWrapped, MARGIN + 3, y);
          y += subWrapped.length * 3.2;
        }
        y += 0.6;
        break;
      }
      case 'space': {
        y += 3;
        break;
      }
    }
  }

  return doc;
}

export async function downloadReceiptPdf(config: ReceiptConfig, ctx: ReceiptContext): Promise<void> {
  const doc = await buildReceiptDoc(config, ctx);
  doc.save(`receipt-${ctx.orderNumber}.pdf`);
}
