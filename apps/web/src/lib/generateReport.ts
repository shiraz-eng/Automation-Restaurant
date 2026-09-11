import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';
import { formatCents } from './format';

export type ReportKpis = {
  net_sales_cents: number;
  orders_count: number;
  aov_cents: number;
  gross_profit_cents: number | null;
  food_cost_pct: number | null;
  avg_rating: number | null;
};
export type ReportDay = { business_date: string; net_sales_cents: number };
export type ReportItem = { name: string; qty_sold: number; revenue_cents: number };
export type ReportSlice = { name: string; revenue_cents: number };
export type ReportFeedback = {
  responses: number;
  avg_overall: number | null;
  avg_food: number | null;
  avg_service: number | null;
  avg_cleanliness: number | null;
  avg_speed: number | null;
  avg_ambiance: number | null;
};
export type ReportAttendance = { full_name: string | null; status: string };

export type ReportData = {
  restaurantName: string;
  periodLabel: string;
  kpis: ReportKpis;
  dailySales: ReportDay[]; // empty for a single-day period — no chart/table drawn
  topProducts: ReportItem[];
  categoryMix: ReportSlice[];
  paymentMix: ReportSlice[];
  feedback: ReportFeedback | null;
  attendance: ReportAttendance[] | null;
  aiSummary: string | null;
};

const MARGIN = 15;
const PAGE_W = 210;
const CONTENT_W = PAGE_W - MARGIN * 2;
const PRIMARY: [number, number, number] = [234, 88, 12];
const MUTED: [number, number, number] = [100, 116, 139];
const BODY: [number, number, number] = [15, 23, 42];
const BORDER: [number, number, number] = [226, 232, 240];

function pct(part: number, whole: number): string {
  return whole > 0 ? `${Math.round((part / whole) * 1000) / 10}%` : '—';
}

/**
 * Builds and downloads a real, vector PDF report — not a screenshot of the
 * page (spec §21, §35). Every number comes from the same data the
 * dashboard's own authoritative RPCs already returned to the caller;
 * this module only lays it out.
 */
export function generateReportPdf(data: ReportData): void {
  const doc = new jsPDF({ unit: 'mm', format: 'a4' });
  let y = MARGIN;

  // ── Header ───────────────────────────────────────────────────────────
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(18);
  doc.setTextColor(...BODY);
  doc.text(data.restaurantName, MARGIN, y);
  y += 8;
  doc.setFontSize(13);
  doc.setTextColor(...PRIMARY);
  doc.text('Restaurant Performance Report', MARGIN, y);
  y += 6;
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9.5);
  doc.setTextColor(...MUTED);
  doc.text(`Period: ${data.periodLabel}`, MARGIN, y);
  doc.text(`Generated: ${new Date().toLocaleString()}`, PAGE_W - MARGIN, y, { align: 'right' });
  y += 4;
  doc.setDrawColor(...BORDER);
  doc.line(MARGIN, y, PAGE_W - MARGIN, y);
  y += 8;

  // ── Executive summary ───────────────────────────────────────────────
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(11.5);
  doc.setTextColor(...BODY);
  doc.text('Executive Summary', MARGIN, y);
  y += 3;

  const summaryRows: [string, string][] = [
    ['Net Sales', formatCents(data.kpis.net_sales_cents)],
    ['Orders', String(data.kpis.orders_count)],
    ['Average Order Value', formatCents(data.kpis.aov_cents)],
  ];
  if (data.kpis.gross_profit_cents != null) summaryRows.push(['Gross Profit', formatCents(data.kpis.gross_profit_cents)]);
  if (data.kpis.food_cost_pct != null) summaryRows.push(['Food Cost %', `${data.kpis.food_cost_pct}%`]);
  if (data.kpis.avg_rating != null) summaryRows.push(['Customer Rating', `${data.kpis.avg_rating.toFixed(1)} / 5`]);

  autoTable(doc, {
    startY: y,
    margin: { left: MARGIN, right: MARGIN },
    theme: 'plain',
    styles: { fontSize: 10, cellPadding: 1.8 },
    columnStyles: { 0: { textColor: MUTED }, 1: { fontStyle: 'bold', textColor: BODY, halign: 'right' } },
    body: summaryRows,
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  y = (doc as any).lastAutoTable.finalY + 8;

  // ── Sales trend (hand-drawn vector bars — not a screenshot) ─────────
  if (data.dailySales.length > 1) {
    y = ensureSpace(doc, y, 55);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(11.5);
    doc.setTextColor(...BODY);
    doc.text('Sales Trend', MARGIN, y);
    y += 6;

    const chartH = 32;
    const chartTop = y;
    const max = Math.max(1, ...data.dailySales.map((d) => d.net_sales_cents));
    const barW = CONTENT_W / data.dailySales.length;
    data.dailySales.forEach((d, i) => {
      const h = (d.net_sales_cents / max) * chartH;
      doc.setFillColor(...PRIMARY);
      doc.rect(MARGIN + i * barW + barW * 0.15, chartTop + (chartH - h), barW * 0.7, h, 'F');
    });
    doc.setDrawColor(...BORDER);
    doc.line(MARGIN, chartTop + chartH, PAGE_W - MARGIN, chartTop + chartH);
    y = chartTop + chartH + 8;

    y = ensureSpace(doc, y, 20);
    autoTable(doc, {
      startY: y,
      margin: { left: MARGIN, right: MARGIN },
      head: [['Date', 'Net Sales']],
      body: data.dailySales.map((d) => [d.business_date, formatCents(d.net_sales_cents)]),
      styles: { fontSize: 8.5, cellPadding: 1.4 },
      headStyles: { fillColor: PRIMARY, textColor: [255, 255, 255] },
      columnStyles: { 1: { halign: 'right' } },
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    y = (doc as any).lastAutoTable.finalY + 8;
  }

  // ── Top products ─────────────────────────────────────────────────────
  if (data.topProducts.length > 0) {
    y = ensureSpace(doc, y, 20);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(11.5);
    doc.text('Top Products', MARGIN, y);
    y += 3;
    autoTable(doc, {
      startY: y,
      margin: { left: MARGIN, right: MARGIN },
      head: [['Item', 'Units sold', 'Revenue']],
      body: data.topProducts.map((p) => [p.name, String(p.qty_sold), formatCents(p.revenue_cents)]),
      styles: { fontSize: 9, cellPadding: 1.6 },
      headStyles: { fillColor: PRIMARY, textColor: [255, 255, 255] },
      columnStyles: { 1: { halign: 'right' }, 2: { halign: 'right' } },
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    y = (doc as any).lastAutoTable.finalY + 8;
  }

  // ── Revenue mix / payment mix side by side (as tables) ──────────────
  const totalCat = data.categoryMix.reduce((s, c) => s + c.revenue_cents, 0);
  const totalPay = data.paymentMix.reduce((s, c) => s + c.revenue_cents, 0);
  if (data.categoryMix.length > 0 || data.paymentMix.length > 0) {
    y = ensureSpace(doc, y, 20);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(11.5);
    doc.text('Revenue Mix', MARGIN, y);
    y += 3;
    if (data.categoryMix.length > 0) {
      autoTable(doc, {
        startY: y,
        margin: { left: MARGIN, right: MARGIN },
        head: [['Category', 'Revenue', '% of sales']],
        body: data.categoryMix.map((c) => [c.name, formatCents(c.revenue_cents), pct(c.revenue_cents, totalCat)]),
        styles: { fontSize: 9, cellPadding: 1.6 },
        headStyles: { fillColor: PRIMARY, textColor: [255, 255, 255] },
        columnStyles: { 1: { halign: 'right' }, 2: { halign: 'right' } },
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      y = (doc as any).lastAutoTable.finalY + 6;
    }
    if (data.paymentMix.length > 0) {
      y = ensureSpace(doc, y, 20);
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(10.5);
      doc.text('Payment Mix', MARGIN, y);
      y += 3;
      autoTable(doc, {
        startY: y,
        margin: { left: MARGIN, right: MARGIN },
        head: [['Method', 'Revenue', '% of sales']],
        body: data.paymentMix.map((c) => [c.name, formatCents(c.revenue_cents), pct(c.revenue_cents, totalPay)]),
        styles: { fontSize: 9, cellPadding: 1.6 },
        headStyles: { fillColor: PRIMARY, textColor: [255, 255, 255] },
        columnStyles: { 1: { halign: 'right' }, 2: { halign: 'right' } },
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      y = (doc as any).lastAutoTable.finalY + 8;
    }
  }

  // ── Customer experience ──────────────────────────────────────────────
  if (data.feedback && data.feedback.responses > 0) {
    y = ensureSpace(doc, y, 30);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(11.5);
    doc.text('Customer Experience', MARGIN, y);
    y += 3;
    const f = data.feedback;
    const rows: [string, string][] = (
      [
        ['Food', f.avg_food],
        ['Service', f.avg_service],
        ['Cleanliness', f.avg_cleanliness],
        ['Speed', f.avg_speed],
        ['Ambiance', f.avg_ambiance],
        ['Overall', f.avg_overall],
      ] as [string, number | null][]
    )
      .filter(([, v]) => v != null)
      .map(([k, v]) => [k, `${(v as number).toFixed(1)} / 5`]);
    autoTable(doc, {
      startY: y,
      margin: { left: MARGIN, right: MARGIN },
      body: rows,
      theme: 'plain',
      styles: { fontSize: 9.5, cellPadding: 1.4 },
      columnStyles: { 0: { textColor: MUTED }, 1: { fontStyle: 'bold', halign: 'right' } },
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    y = (doc as any).lastAutoTable.finalY + 2;
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8.5);
    doc.setTextColor(...MUTED);
    doc.text(`${f.responses} response${f.responses === 1 ? '' : 's'} in this period.`, MARGIN, y + 4);
    y += 10;
  }

  // ── Staff attendance (today) ─────────────────────────────────────────
  if (data.attendance && data.attendance.length > 0) {
    y = ensureSpace(doc, y, 20);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(11.5);
    doc.setTextColor(...BODY);
    doc.text('Staff Attendance — Today', MARGIN, y);
    y += 3;
    autoTable(doc, {
      startY: y,
      margin: { left: MARGIN, right: MARGIN },
      head: [['Staff', 'Status']],
      body: data.attendance.map((a) => [a.full_name ?? '—', a.status.replace('_', ' ')]),
      styles: { fontSize: 9, cellPadding: 1.4 },
      headStyles: { fillColor: PRIMARY, textColor: [255, 255, 255] },
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    y = (doc as any).lastAutoTable.finalY + 8;
  }

  // ── AI summary ────────────────────────────────────────────────────────
  y = ensureSpace(doc, y, 25);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(11.5);
  doc.setTextColor(...BODY);
  doc.text('AI Summary', MARGIN, y);
  y += 6;
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9.5);
  if (data.aiSummary) {
    doc.setTextColor(...BODY);
    const lines = doc.splitTextToSize(data.aiSummary, CONTENT_W);
    doc.text(lines, MARGIN, y);
  } else {
    doc.setTextColor(...MUTED);
    doc.text('No AI summary was requested for this report — ask the dashboard AI a question first, then generate again to include it.', MARGIN, y);
  }

  // ── Footer on every page ────────────────────────────────────────────
  const pageCount = doc.getNumberOfPages();
  for (let i = 1; i <= pageCount; i++) {
    doc.setPage(i);
    doc.setDrawColor(...BORDER);
    doc.line(MARGIN, 287, PAGE_W - MARGIN, 287);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    doc.setTextColor(...MUTED);
    doc.text('Automation Restaurant', MARGIN, 292);
    doc.text(`Page ${i} of ${pageCount}`, PAGE_W - MARGIN, 292, { align: 'right' });
  }

  const stamp = new Date().toISOString().slice(0, 10);
  doc.save(`${data.restaurantName.replace(/[^a-z0-9]+/gi, '-')}-report-${stamp}.pdf`);
}

function ensureSpace(doc: jsPDF, y: number, needed: number): number {
  if (y + needed > 280) {
    doc.addPage();
    return MARGIN;
  }
  return y;
}
