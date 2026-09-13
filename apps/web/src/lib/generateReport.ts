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
// cogs_cents/contribution_cents/contribution_margin_pct are optional — a
// caller without cost visibility (or the simpler pre-profitability
// product list) still renders a valid, if plainer, table (spec §33).
export type ReportItem = {
  name: string;
  qty_sold: number;
  revenue_cents: number;
  cogs_cents?: number;
  contribution_cents?: number;
  contribution_margin_pct?: number | null;
};
export type ReportSlice = { name: string; revenue_cents: number };
export type ReportExpenseRecord = { category: string; description: string | null; amount_cents: number; expense_date: string };
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

// ── Restaurant Performance & Owner Activity Intelligence (spec §28) ───────
// Same shapes get_purchasing_summary / supplier_payable() / get_owner_activity
// / computeAttentionItems() already return elsewhere — this module only lays
// them out, never recomputes them. All optional: undefined means the caller
// couldn't see that data (permission), an empty array/zero means genuinely none.
export type ReportPurchasing = {
  total_purchases_cents: number;
  purchase_orders: number;
  received_value_cents: number;
  pending_value_cents: number;
  by_supplier: { supplier: string; cents: number }[];
};
export type ReportSupplierPayable = {
  invoiced_cents: number;
  approved_cents: number;
  paid_cents: number;
  on_hold_cents: number;
  outstanding_cents: number;
  overdue_cents: number;
  by_supplier: { supplier_name: string; invoiced_cents: number; paid_cents: number; outstanding_cents: number; overdue_cents: number }[];
};
export type ReportManagementActivity = {
  purchase_orders_created: number;
  purchase_orders_received: number;
  supplier_payments_made: number;
  supplier_payments_total_cents: number;
  expenses_recorded: number;
  stock_adjustments: number;
  stock_counts: number;
  menu_updates: number;
  promotions_created: number;
};
export type ReportAttentionItem = { severity: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW'; category: string; message: string };

// The full period_profitability() row (same RPC the dashboard, /finance,
// and the AI assistant already call) — optional so a caller without
// finance permission still gets a valid report, just without this section,
// exactly like the dashboard already silently omits it for that role.
export type ReportProfitDetail = {
  gross_sales_cents: number;
  discount_cents: number;
  refunded_cents: number;
  net_sales_cents: number;
  theoretical_cogs_cents: number;
  cogs_lines_total: number;
  cogs_lines_missing: number;
  gross_profit_cents: number;
  gross_margin_pct: number | null;
  actual_cogs_cents: number;
  cogs_variance_cents: number;
  expenses_cents: number;
  net_profit_cents: number;
  net_profit_margin_pct: number | null;
} | null;

export type ReportData = {
  restaurantName: string;
  periodLabel: string;
  kpis: ReportKpis;
  profitDetail?: ReportProfitDetail;
  dailySales: ReportDay[]; // empty for a single-day period — no chart/table drawn
  topProducts: ReportItem[];
  // Individual expense records dated in the period (spec §36) — omitted
  // (undefined) for a caller without expense visibility, distinct from an
  // empty array (visible, genuinely none recorded).
  expenseRecords?: ReportExpenseRecord[];
  categoryMix: ReportSlice[];
  paymentMix: ReportSlice[];
  feedback: ReportFeedback | null;
  attendance: ReportAttendance[] | null;
  purchasing?: ReportPurchasing;
  supplierPayable?: ReportSupplierPayable;
  managementActivity?: ReportManagementActivity;
  attentionItems?: ReportAttentionItem[];
  aiSummary: string | null;
};

const MARGIN = 15;
const PAGE_W = 210;
const CONTENT_W = PAGE_W - MARGIN * 2;
const PRIMARY: [number, number, number] = [234, 88, 12];
const MUTED: [number, number, number] = [100, 116, 139];
const BODY: [number, number, number] = [15, 23, 42];
const BORDER: [number, number, number] = [226, 232, 240];
const OK: [number, number, number] = [22, 163, 74];
const WARN: [number, number, number] = [217, 119, 6];

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
  if (data.profitDetail) {
    summaryRows.push(['Net Profit', formatCents(data.profitDetail.net_profit_cents)]);
    summaryRows.push(['Net Profit Margin', data.profitDetail.net_profit_margin_pct != null ? `${data.profitDetail.net_profit_margin_pct}%` : 'N/A']);
  }
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

  // ── Profit & Loss waterfall + verification (spec §3, §7, §37) ────────
  // Every value below comes straight from period_profitability() — the
  // SAME authoritative RPC the dashboard, /finance, and the AI assistant
  // already call. This section never recomputes anything; it only lays
  // the bridge out so it can be checked line by line.
  if (data.profitDetail) {
    const pd = data.profitDetail;
    y = ensureSpace(doc, y, 60);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(11.5);
    doc.setTextColor(...BODY);
    doc.text('Profit & Loss', MARGIN, y);
    y += 3;
    // Plain ASCII hyphens, not U+2212 MINUS SIGN — jsPDF's standard 14
    // fonts only cover WinAnsiEncoding (~Latin-1 + cp1252 extras like em
    // dash), which does NOT include the mathematical minus sign; that
    // glyph would silently fail to render rather than throw.
    const bridgeRows: [string, string, boolean][] = [
      ['Gross Sales', formatCents(pd.gross_sales_cents), true],
      ['- Discounts', `-${formatCents(pd.discount_cents)}`, false],
      ['- Refunds', `-${formatCents(pd.refunded_cents)}`, false],
      ['= Net Sales', formatCents(pd.net_sales_cents), true],
      ['- COGS (theoretical, from recipes)', `-${formatCents(pd.theoretical_cogs_cents)}`, false],
      ['= Gross Profit', formatCents(pd.gross_profit_cents), true],
      ['- Expenses (all recorded)', `-${formatCents(pd.expenses_cents)}`, false],
      ['= NET PROFIT', formatCents(pd.net_profit_cents), true],
    ];
    autoTable(doc, {
      startY: y,
      margin: { left: MARGIN, right: MARGIN },
      theme: 'plain',
      styles: { fontSize: 10, cellPadding: 1.6 },
      columnStyles: { 0: { textColor: MUTED }, 1: { halign: 'right' } },
      body: bridgeRows.map(([label, value, bold]) => [
        { content: label, styles: bold ? { fontStyle: 'bold', textColor: BODY } : {} },
        { content: value, styles: bold ? { fontStyle: 'bold', textColor: BODY } : {} },
      ]),
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    y = (doc as any).lastAutoTable.finalY + 2;
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9);
    doc.setTextColor(...MUTED);
    doc.text(
      `Gross margin ${pd.gross_margin_pct != null ? `${pd.gross_margin_pct}%` : 'N/A'} · Net margin ${pd.net_profit_margin_pct != null ? `${pd.net_profit_margin_pct}%` : 'N/A'}`,
      MARGIN,
      y + 4,
    );
    y += 12;

    // Verification — an honest checklist, never a claim the data doesn't
    // actually support (spec §26-27).
    y = ensureSpace(doc, y, 40);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(10.5);
    doc.setTextColor(...BODY);
    doc.text('Profit Calculation Verification', MARGIN, y);
    y += 5;
    const checks: [boolean, string][] = [
      [true, `Sales scoped to ${data.periodLabel} — served/paid orders only.`],
      [pd.cogs_lines_missing === 0, pd.cogs_lines_missing === 0
        ? 'Every sold line had a recipe configured — COGS reflects the full period.'
        : `${pd.cogs_lines_missing} of ${pd.cogs_lines_total} sold line(s) have no recipe configured — COGS and gross profit understate the true figure.`],
      [true, `Actual ingredient value consumed/wasted/adjusted (stock ledger): ${formatCents(pd.actual_cogs_cents)}${pd.cogs_variance_cents !== 0 ? `, ${pd.cogs_variance_cents > 0 ? 'above' : 'below'} the recipe-based figure by ${formatCents(Math.abs(pd.cogs_variance_cents))}.` : ', matching the recipe-based figure.'}`],
      [true, `Expenses included: ${formatCents(pd.expenses_cents)} across all recorded expense records dated in this period.`],
      [false, 'Labor/payroll cost is not separately tracked — only reflected above if entered as an expense record. Net Profit may overstate true profit if it was not.'],
    ];
    const fullyCalculated = checks.every(([ok]) => ok);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(9.5);
    doc.setTextColor(...(fullyCalculated ? OK : WARN));
    doc.text(fullyCalculated ? 'Status: Fully calculated from recorded data' : 'Status: Partially calculated — see below', MARGIN, y);
    y += 5;
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8.5);
    checks.forEach(([ok, text]) => {
      y = ensureSpace(doc, y, 10);
      doc.setTextColor(...(ok ? BODY : WARN));
      // Same WinAnsi constraint as above — no checkmark/warning glyphs.
      const lines = doc.splitTextToSize(`${ok ? '[OK]' : '[!]'} ${text}`, CONTENT_W);
      doc.text(lines, MARGIN, y);
      y += lines.length * 4 + 1.5;
    });
    y += 4;
  }

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

  // ── Product profitability (spec §33) — a richer table (COGS,
  // contribution, margin) when that data is present, falling back to the
  // plain units/revenue table for a caller without cost visibility. ────
  if (data.topProducts.length > 0) {
    const hasCogs = data.topProducts.some((p) => p.cogs_cents != null);
    y = ensureSpace(doc, y, 20);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(11.5);
    doc.text(hasCogs ? 'Product Profitability' : 'Top Products', MARGIN, y);
    y += 3;
    if (hasCogs) {
      autoTable(doc, {
        startY: y,
        margin: { left: MARGIN, right: MARGIN },
        head: [['Item', 'Units', 'Revenue', 'COGS', 'Contribution', 'Margin']],
        body: data.topProducts.map((p) => [
          p.name,
          String(p.qty_sold),
          formatCents(p.revenue_cents),
          p.cogs_cents != null ? formatCents(p.cogs_cents) : '—',
          p.contribution_cents != null ? formatCents(p.contribution_cents) : '—',
          p.contribution_margin_pct != null ? `${p.contribution_margin_pct}%` : 'N/A',
        ]),
        styles: { fontSize: 8.5, cellPadding: 1.5 },
        headStyles: { fillColor: PRIMARY, textColor: [255, 255, 255] },
        columnStyles: { 1: { halign: 'right' }, 2: { halign: 'right' }, 3: { halign: 'right' }, 4: { halign: 'right' }, 5: { halign: 'right' } },
      });
    } else {
      autoTable(doc, {
        startY: y,
        margin: { left: MARGIN, right: MARGIN },
        head: [['Item', 'Units sold', 'Revenue']],
        body: data.topProducts.map((p) => [p.name, String(p.qty_sold), formatCents(p.revenue_cents)]),
        styles: { fontSize: 9, cellPadding: 1.6 },
        headStyles: { fillColor: PRIMARY, textColor: [255, 255, 255] },
        columnStyles: { 1: { halign: 'right' }, 2: { halign: 'right' } },
      });
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    y = (doc as any).lastAutoTable.finalY + 8;
  }

  // ── Expense breakdown (spec §36) — category totals as a % of net
  // sales, then every underlying record, so an expense line is never a
  // mystery number. Undefined means "no visibility into expenses" and
  // omits the section entirely; an empty array means "genuinely none
  // recorded" and says so explicitly rather than skipping silently. ────
  if (data.expenseRecords) {
    y = ensureSpace(doc, y, 20);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(11.5);
    doc.setTextColor(...BODY);
    doc.text('Expenses', MARGIN, y);
    y += 3;
    if (data.expenseRecords.length === 0) {
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(9);
      doc.setTextColor(...MUTED);
      doc.text('No expense records dated in this period.', MARGIN, y + 3);
      y += 10;
    } else {
      const byCategory = data.expenseRecords.reduce<Record<string, number>>((acc, r) => {
        acc[r.category] = (acc[r.category] ?? 0) + r.amount_cents;
        return acc;
      }, {});
      const netSales = data.profitDetail?.net_sales_cents ?? data.kpis.net_sales_cents;
      autoTable(doc, {
        startY: y,
        margin: { left: MARGIN, right: MARGIN },
        head: [['Category', 'Amount', '% of Net Sales']],
        body: Object.entries(byCategory)
          .sort((a, b) => b[1] - a[1])
          .map(([cat, cents]) => [cat, formatCents(cents), pct(cents, netSales)]),
        styles: { fontSize: 9, cellPadding: 1.6 },
        headStyles: { fillColor: PRIMARY, textColor: [255, 255, 255] },
        columnStyles: { 1: { halign: 'right' }, 2: { halign: 'right' } },
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      y = (doc as any).lastAutoTable.finalY + 4;
      y = ensureSpace(doc, y, 20);
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(9.5);
      doc.setTextColor(...BODY);
      doc.text('Individual records', MARGIN, y);
      y += 2;
      autoTable(doc, {
        startY: y,
        margin: { left: MARGIN, right: MARGIN },
        head: [['Date', 'Category', 'Description', 'Amount']],
        body: data.expenseRecords
          .slice()
          .sort((a, b) => b.amount_cents - a.amount_cents)
          .map((r) => [r.expense_date, r.category, r.description ?? '—', formatCents(r.amount_cents)]),
        styles: { fontSize: 8, cellPadding: 1.3 },
        headStyles: { fillColor: PRIMARY, textColor: [255, 255, 255] },
        columnStyles: { 3: { halign: 'right' } },
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      y = (doc as any).lastAutoTable.finalY + 8;
    }
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

  // ── Purchasing (spec §28) ─────────────────────────────────────────────
  if (data.purchasing) {
    const pu = data.purchasing;
    y = ensureSpace(doc, y, 20);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(11.5);
    doc.setTextColor(...BODY);
    doc.text('Purchasing', MARGIN, y);
    y += 3;
    autoTable(doc, {
      startY: y,
      margin: { left: MARGIN, right: MARGIN },
      theme: 'plain',
      styles: { fontSize: 10, cellPadding: 1.6 },
      columnStyles: { 0: { textColor: MUTED }, 1: { fontStyle: 'bold', textColor: BODY, halign: 'right' } },
      body: [
        ['Total Purchases', formatCents(pu.total_purchases_cents)],
        ['Purchase Orders', String(pu.purchase_orders)],
        ['Received Value', formatCents(pu.received_value_cents)],
        ['Pending Value', formatCents(pu.pending_value_cents)],
      ],
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    y = (doc as any).lastAutoTable.finalY + 4;
    if (pu.by_supplier.length > 0) {
      y = ensureSpace(doc, y, 20);
      autoTable(doc, {
        startY: y,
        margin: { left: MARGIN, right: MARGIN },
        head: [['Supplier', 'Purchased']],
        body: pu.by_supplier.slice(0, 10).map((s) => [s.supplier, formatCents(s.cents)]),
        styles: { fontSize: 8.5, cellPadding: 1.4 },
        headStyles: { fillColor: PRIMARY, textColor: [255, 255, 255] },
        columnStyles: { 1: { halign: 'right' } },
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      y = (doc as any).lastAutoTable.finalY + 8;
    } else {
      y += 6;
    }
  }

  // ── Supplier Payments / Accounts Payable (spec §28) ────────────────────
  if (data.supplierPayable) {
    const sp = data.supplierPayable;
    y = ensureSpace(doc, y, 20);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(11.5);
    doc.setTextColor(...BODY);
    doc.text('Supplier Payments', MARGIN, y);
    y += 3;
    autoTable(doc, {
      startY: y,
      margin: { left: MARGIN, right: MARGIN },
      theme: 'plain',
      styles: { fontSize: 10, cellPadding: 1.6 },
      columnStyles: { 0: { textColor: MUTED }, 1: { fontStyle: 'bold', textColor: BODY, halign: 'right' } },
      body: [
        ['Total Invoiced', formatCents(sp.invoiced_cents)],
        ['Approved', formatCents(sp.approved_cents)],
        ['Paid', formatCents(sp.paid_cents)],
        ['On Hold', formatCents(sp.on_hold_cents)],
        ['Outstanding', formatCents(sp.outstanding_cents)],
        [{ content: 'Overdue', styles: sp.overdue_cents > 0 ? { textColor: WARN } : {} } as unknown as string, { content: formatCents(sp.overdue_cents), styles: sp.overdue_cents > 0 ? { fontStyle: 'bold', textColor: WARN } : {} } as unknown as string],
      ],
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    y = (doc as any).lastAutoTable.finalY + 4;
    if (sp.by_supplier.length > 0) {
      y = ensureSpace(doc, y, 20);
      autoTable(doc, {
        startY: y,
        margin: { left: MARGIN, right: MARGIN },
        head: [['Supplier', 'Invoiced', 'Paid', 'Outstanding', 'Overdue']],
        body: sp.by_supplier
          .slice()
          .sort((a, b) => b.outstanding_cents - a.outstanding_cents)
          .slice(0, 10)
          .map((s) => [s.supplier_name, formatCents(s.invoiced_cents), formatCents(s.paid_cents), formatCents(s.outstanding_cents), formatCents(s.overdue_cents)]),
        styles: { fontSize: 8, cellPadding: 1.3 },
        headStyles: { fillColor: PRIMARY, textColor: [255, 255, 255] },
        columnStyles: { 1: { halign: 'right' }, 2: { halign: 'right' }, 3: { halign: 'right' }, 4: { halign: 'right' } },
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      y = (doc as any).lastAutoTable.finalY + 8;
    } else {
      y += 6;
    }
  }

  // ── Management Activity (spec §2, §13, §19) — what the owner actually
  // did, every count from a real audit/activity record. ──────────────────
  if (data.managementActivity) {
    const ma = data.managementActivity;
    y = ensureSpace(doc, y, 20);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(11.5);
    doc.setTextColor(...BODY);
    doc.text('Management Activity', MARGIN, y);
    y += 3;
    autoTable(doc, {
      startY: y,
      margin: { left: MARGIN, right: MARGIN },
      theme: 'plain',
      styles: { fontSize: 9.5, cellPadding: 1.4 },
      columnStyles: { 0: { textColor: MUTED }, 1: { fontStyle: 'bold', textColor: BODY, halign: 'right' } },
      body: [
        ['Purchase Orders Created', String(ma.purchase_orders_created)],
        ['Purchase Orders Received', String(ma.purchase_orders_received)],
        ['Supplier Payments Made', `${ma.supplier_payments_made} (${formatCents(ma.supplier_payments_total_cents)})`],
        ['Expenses Recorded', String(ma.expenses_recorded)],
        ['Stock Adjustments', String(ma.stock_adjustments)],
        ['Stock Counts', String(ma.stock_counts)],
        ['Menu Updates', String(ma.menu_updates)],
        ['Promotions Created', String(ma.promotions_created)],
      ],
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    y = (doc as any).lastAutoTable.finalY + 8;
  }

  // ── Attention Items (spec §21) — ranked exceptions, each with real
  // evidence; never presented as fabricated advice. ──────────────────────
  if (data.attentionItems) {
    y = ensureSpace(doc, y, 20);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(11.5);
    doc.setTextColor(...BODY);
    doc.text('Attention Items', MARGIN, y);
    y += 3;
    if (data.attentionItems.length === 0) {
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(9);
      doc.setTextColor(...OK);
      doc.text('Nothing needs attention right now.', MARGIN, y + 3);
      y += 10;
    } else {
      autoTable(doc, {
        startY: y,
        margin: { left: MARGIN, right: MARGIN },
        head: [['Severity', 'Category', 'Issue']],
        body: data.attentionItems.map((a) => [a.severity, a.category, a.message]),
        styles: { fontSize: 8, cellPadding: 1.4 },
        headStyles: { fillColor: PRIMARY, textColor: [255, 255, 255] },
        columnStyles: { 0: { cellWidth: 20 }, 1: { cellWidth: 25 } },
        didParseCell: (hookData) => {
          if (hookData.section === 'body' && hookData.column.index === 0) {
            const sev = String(hookData.cell.raw ?? '');
            if (sev === 'CRITICAL' || sev === 'HIGH') hookData.cell.styles.textColor = WARN;
          }
        },
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      y = (doc as any).lastAutoTable.finalY + 8;
    }
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
