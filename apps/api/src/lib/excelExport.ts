import ExcelJS from 'exceljs';
import type { SupabaseClient } from '@supabase/supabase-js';
import { resolvePeriod, computeAttentionItems, forwardRange, AI_TOOLS } from './aiTools';

/**
 * Restaurant Performance & Owner Activity Intelligence — Excel export
 * (spec's "PDF & Excel Export / Detailed Analysis System").
 *
 * The PDF is for understanding performance (KPIs, charts, a narrative);
 * this workbook is for independent verification and deeper investigation —
 * detailed, sortable/filterable rows an accountant can reconcile against
 * the PDF's headline numbers. Every sheet below reads the SAME
 * authoritative RPCs/tables every other surface in this app already uses
 * (period_profitability, item_profitability, deal_profitability,
 * supplier_payable, the stock ledger) — nothing here is a second
 * calculation, and nothing is fabricated: a sheet with no rows for the
 * period says so explicitly rather than being silently empty.
 *
 * Scope note: this is a curated set of the sheets the master spec
 * suggested (Executive Summary, Profit Summary, Daily Performance, Orders,
 * Product Profitability, Deal Profitability, Promotions, Purchasing,
 * Accounts Payable, Supplier Payments, Supplier Performance, Inventory,
 * Expenses, Management Activity, AI Actions, Verification — 16 sheets)
 * rather than a literal one-sheet-per-table dump of all ~35 suggested —
 * a few of those (Order Items, COGS, Recipes, Stock Movements, Receiving)
 * would either duplicate detail already reachable via this app's own
 * drill-downs or require per-order/per-line RPC calls that don't scale to
 * an arbitrary period without a real job queue. This set covers every
 * headline figure the PDF prints, with the detail to independently verify
 * each one.
 */

const HEADER_FILL: ExcelJS.Fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEA580C' } };
const HEADER_FONT: Partial<ExcelJS.Font> = { bold: true, color: { argb: 'FFFFFFFF' } };
const MONEY_FMT = '$#,##0.00';
const PCT_FMT = '0.0"%"';

function styleHeaderRow(row: ExcelJS.Row) {
  row.eachCell((cell) => {
    cell.fill = HEADER_FILL;
    cell.font = HEADER_FONT;
  });
  row.height = 18;
}

function addTable(
  sheet: ExcelJS.Worksheet,
  columns: { header: string; key: string; width?: number; style?: Partial<ExcelJS.Style> }[],
  rows: Record<string, unknown>[],
  emptyNote?: string,
) {
  sheet.columns = columns.map((c) => ({ header: c.header, key: c.key, width: c.width ?? 18, style: c.style }));
  styleHeaderRow(sheet.getRow(1));
  sheet.views = [{ state: 'frozen', ySplit: 1 }];
  sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: columns.length } };
  if (rows.length === 0) {
    const r = sheet.addRow([emptyNote ?? 'No records for this period.']);
    r.font = { italic: true, color: { argb: 'FF64748B' } };
    sheet.mergeCells(r.number, 1, r.number, Math.max(columns.length, 1));
    return;
  }
  for (const row of rows) sheet.addRow(row);
}

const one = <T,>(v: T | T[] | null): T | null => (Array.isArray(v) ? (v[0] ?? null) : v);
const centsToDollars = (c: number | null | undefined) => (typeof c === 'number' ? c / 100 : null);

// Every optional sheet this workbook can build, in the order it builds
// them — the "Custom Export" domain picker (spec §37) selects from this
// list. Executive Summary, Profit Summary and Verification are always
// included regardless of selection: they're the reconciliation backbone
// the other sheets exist to support, not a domain someone would opt out of.
export const EXCEL_ANCHOR_SHEETS = ['Executive Summary', 'Profit Summary', 'Verification'] as const;
export const EXCEL_OPTIONAL_SHEETS = [
  'Daily Performance', 'Orders', 'Product Profitability', 'Deal Profitability', 'Promotions',
  'Purchasing', 'Accounts Payable', 'Supplier Payments', 'Supplier Performance', 'Inventory',
  'Expenses', 'Management Activity', 'AI Actions',
] as const;

export async function buildExcelWorkbook(
  admin: SupabaseClient,
  restaurantName: string,
  rangeArgs: { period?: unknown; from?: unknown; to?: unknown },
  // Custom Export (spec §37): when given, only these sheets (plus the
  // always-included anchors above) survive in the final workbook. Every
  // sheet is still built the same way internally — this only prunes the
  // result afterward (see the removeWorksheet pass at the end) rather
  // than threading a condition through each of the 16 sheet-building
  // blocks, which stays untouched and exactly as already verified.
  includeSheets?: string[],
): Promise<{ ok: true; workbook: ExcelJS.Workbook; periodLabel: string } | { ok: false; error: string }> {
  const { from, to, label } = resolvePeriod(rangeArgs);
  const fromIso = from.toISOString();
  const toIso = to.toISOString();
  const fromDate = fromIso.slice(0, 10);
  const toDate = toIso.slice(0, 10);
  // Forwarded to get_owner_activity below as an exact range, not a bare
  // period name — reuses aiTools.ts's own forwardRange() (not a
  // re-inlined "-1ms then UTC slice", which shifts the date on a
  // negative-UTC-offset server — see its own comment for the live repro).
  const ownerActivityRange = forwardRange({ from, to });

  const [
    profitRes, dailyRes, itemProfRes, dealProfRes, ordersRes, poRes, payableRes,
    paymentsRes, invRes, expensesRes, ownerActivityRaw, attentionItems,
    promoRes, supplierPerfRaw, aiActionsRes,
  ] = await Promise.all([
    admin.rpc('period_profitability', { p_from: fromIso, p_to: toIso }),
    admin.rpc('sales_by_day', { p_from: fromDate, p_to: toDate }),
    admin.rpc('item_profitability', { p_from: fromIso, p_to: toIso }),
    admin.rpc('deal_profitability', { p_from: fromIso, p_to: toIso }),
    admin
      .from('orders')
      .select('order_number, created_at, channel, table_label, status, subtotal_cents, discount_cents, tax_cents, total_cents, refunded_cents, paid_at')
      .gte('created_at', fromIso)
      .lt('created_at', toIso)
      .order('order_number', { ascending: false }),
    admin
      .from('purchase_orders')
      .select('po_number, status, created_at, expected_at, received_at, subtotal_cents, suppliers(name)')
      .gte('created_at', fromIso)
      .lt('created_at', toIso)
      .order('po_number', { ascending: false }),
    admin.rpc('supplier_payable'),
    admin
      .from('supplier_payments')
      .select('paid_at, amount_cents, method, reference, note, suppliers(name)')
      .gte('paid_at', fromIso)
      .lt('paid_at', toIso)
      .order('paid_at', { ascending: false }),
    admin.from('inventory_items').select('name, unit, stock_qty, min_threshold, cost_cents_per_base_unit').order('name'),
    admin
      .from('expenses')
      .select('expense_date, category, description, amount_cents')
      .gte('expense_date', fromDate)
      .lt('expense_date', toDate)
      .order('expense_date', { ascending: false }),
    AI_TOOLS.find((t) => t.name === 'get_owner_activity')!.run(admin, ownerActivityRange),
    computeAttentionItems(admin),
    admin.rpc('promotion_performance', { p_from: fromIso, p_to: toIso }),
    AI_TOOLS.find((t) => t.name === 'get_supplier_performance')!.run(admin, {}),
    admin
      .from('ai_pending_actions')
      .select('action_name, status, summary, proposed_by_email, proposed_by_role, created_at, resolved_at, resolved_by_email, result, error')
      .gte('created_at', fromIso)
      .lt('created_at', toIso)
      .order('created_at', { ascending: false }),
  ]);

  const profit = (profitRes.data as
    | {
        gross_sales_cents: number; discount_cents: number; refunded_cents: number; net_sales_cents: number;
        orders_count: number; avg_order_cents: number; theoretical_cogs_cents: number; cogs_lines_total: number;
        cogs_lines_missing: number; gross_profit_cents: number; gross_margin_pct: number | null; food_cost_pct: number | null;
        actual_cogs_cents: number; cogs_variance_cents: number; expenses_cents: number; net_profit_cents: number; net_profit_margin_pct: number | null;
      }[]
    | null)?.[0];
  if (profitRes.error || !profit) {
    return { ok: false, error: profitRes.error?.message ?? 'no_profit_data' };
  }

  const wb = new ExcelJS.Workbook();
  wb.creator = 'Automation Restaurant';
  wb.created = new Date();

  // ── 01 Executive Summary ────────────────────────────────────────────
  const exec = wb.addWorksheet('Executive Summary');
  exec.columns = [{ width: 28 }, { width: 22 }];
  exec.addRow(['Automation Restaurant', '']).font = { bold: true, size: 14 };
  exec.addRow(['Restaurant', restaurantName]);
  exec.addRow(['Period', label]);
  exec.addRow(['Generated', new Date().toLocaleString()]);
  exec.addRow([]);
  const execRows: [string, number | string][] = [
    ['Gross Sales', centsToDollars(profit.gross_sales_cents)!],
    ['Discounts', centsToDollars(profit.discount_cents)!],
    ['Refunds', centsToDollars(profit.refunded_cents)!],
    ['Net Sales', centsToDollars(profit.net_sales_cents)!],
    ['COGS (theoretical)', centsToDollars(profit.theoretical_cogs_cents)!],
    ['Gross Profit', centsToDollars(profit.gross_profit_cents)!],
    ['Operating Expenses', centsToDollars(profit.expenses_cents)!],
    ['Net Profit', centsToDollars(profit.net_profit_cents)!],
    ['Gross Margin %', profit.gross_margin_pct ?? 'N/A'],
    ['Net Margin %', profit.net_profit_margin_pct ?? 'N/A'],
    ['Orders', profit.orders_count],
    ['Average Order Value', centsToDollars(profit.avg_order_cents)!],
  ];
  for (const [label2, value] of execRows) {
    const r = exec.addRow([label2, value]);
    if (typeof value === 'number' && label2.includes('%')) r.getCell(2).numFmt = PCT_FMT;
    else if (typeof value === 'number' && !label2.match(/^(Orders)$/)) r.getCell(2).numFmt = MONEY_FMT;
    r.getCell(1).font = { color: { argb: 'FF64748B' } };
    r.getCell(2).font = { bold: true };
  }

  // ── 02 Profit Summary — the reconciliation-grade sheet (spec §18) ─────
  const profitSheet = wb.addWorksheet('Profit Summary');
  addTable(
    profitSheet,
    [
      { header: 'Metric', key: 'metric', width: 26 },
      { header: 'Amount', key: 'amount', width: 16, style: { numFmt: MONEY_FMT } },
      { header: 'Calculation', key: 'calc', width: 40 },
      { header: 'Source', key: 'source', width: 14 },
    ],
    [
      { metric: 'Gross Sales', amount: centsToDollars(profit.gross_sales_cents), calc: 'Sum of completed order totals before discount/refund', source: 'ACTUAL' },
      { metric: 'Discounts', amount: centsToDollars(profit.discount_cents), calc: 'Recorded discounts', source: 'ACTUAL' },
      { metric: 'Refunds', amount: centsToDollars(profit.refunded_cents), calc: 'Recorded refunds', source: 'ACTUAL' },
      { metric: 'Net Sales', amount: centsToDollars(profit.net_sales_cents), calc: 'Gross Sales - Discounts - Refunds', source: 'CALCULATED' },
      { metric: 'COGS (theoretical)', amount: centsToDollars(profit.theoretical_cogs_cents), calc: `From each sold line's recipe (${profit.cogs_lines_total - profit.cogs_lines_missing}/${profit.cogs_lines_total} lines have a recipe)`, source: 'CALCULATED' },
      { metric: 'Gross Profit', amount: centsToDollars(profit.gross_profit_cents), calc: 'Net Sales - COGS', source: 'CALCULATED' },
      { metric: 'Actual COGS (ledger)', amount: centsToDollars(profit.actual_cogs_cents), calc: 'Ingredient value consumed/wasted/adjusted, from the stock ledger', source: 'ACTUAL' },
      { metric: 'COGS Variance', amount: centsToDollars(profit.cogs_variance_cents), calc: 'Actual COGS - Theoretical COGS', source: 'CALCULATED' },
      { metric: 'Operating Expenses', amount: centsToDollars(profit.expenses_cents), calc: 'Sum of expense records dated in this period', source: 'ACTUAL' },
      { metric: 'Net Profit', amount: centsToDollars(profit.net_profit_cents), calc: 'Gross Profit - Operating Expenses', source: 'CALCULATED' },
    ],
  );

  // ── 03 Daily Performance ───────────────────────────────────────────
  const daily = wb.addWorksheet('Daily Performance');
  const dailyRows = ((dailyRes.data ?? []) as { business_date: string; net_sales_cents: number; orders_count: number }[]).map((d) => ({
    date: d.business_date,
    net_sales: centsToDollars(d.net_sales_cents),
    orders: d.orders_count,
    aov: d.orders_count > 0 ? Math.round(d.net_sales_cents / d.orders_count) / 100 : 0,
  }));
  addTable(
    daily,
    [
      { header: 'Date', key: 'date', width: 14 },
      { header: 'Net Sales', key: 'net_sales', width: 14, style: { numFmt: MONEY_FMT } },
      { header: 'Orders', key: 'orders', width: 10 },
      { header: 'AOV', key: 'aov', width: 12, style: { numFmt: MONEY_FMT } },
    ],
    dailyRows,
  );

  // ── 04 Orders ────────────────────────────────────────────────────────
  const ordersSheet = wb.addWorksheet('Orders');
  const orderRows = ((ordersRes.data ?? []) as {
    order_number: number; created_at: string; channel: string; table_label: string | null; status: string;
    subtotal_cents: number; discount_cents: number; tax_cents: number; total_cents: number; refunded_cents: number; paid_at: string | null;
  }[]).map((o) => ({
    order_number: o.order_number,
    date: o.created_at.slice(0, 10),
    where: o.table_label ?? o.channel,
    status: o.status,
    subtotal: centsToDollars(o.subtotal_cents),
    discount: centsToDollars(o.discount_cents),
    tax: centsToDollars(o.tax_cents),
    total: centsToDollars(o.total_cents),
    refunded: centsToDollars(o.refunded_cents),
    paid: o.paid_at ? 'Yes' : 'No',
  }));
  addTable(
    ordersSheet,
    [
      { header: 'Order #', key: 'order_number', width: 10 },
      { header: 'Date', key: 'date', width: 12 },
      { header: 'Where', key: 'where', width: 14 },
      { header: 'Status', key: 'status', width: 12 },
      { header: 'Subtotal', key: 'subtotal', width: 12, style: { numFmt: MONEY_FMT } },
      { header: 'Discount', key: 'discount', width: 12, style: { numFmt: MONEY_FMT } },
      { header: 'Tax', key: 'tax', width: 10, style: { numFmt: MONEY_FMT } },
      { header: 'Total', key: 'total', width: 12, style: { numFmt: MONEY_FMT } },
      { header: 'Refunded', key: 'refunded', width: 12, style: { numFmt: MONEY_FMT } },
      { header: 'Paid', key: 'paid', width: 8 },
    ],
    orderRows,
  );
  // Per-order COGS/contribution is available via the app's own order
  // drill-down (order_profitability()) — not repeated per-row here since
  // that would mean one RPC call per order with no bound on how many
  // orders a period can contain. Noted rather than silently omitted.
  ordersSheet.addRow([]);
  const noteRow = ordersSheet.addRow(['Per-order COGS/contribution: open the order in the app\'s AI chat or Orders page for its full profitability breakdown.']);
  noteRow.font = { italic: true, color: { argb: 'FF64748B' } };
  ordersSheet.mergeCells(noteRow.number, 1, noteRow.number, 10);

  // ── 05 Product Profitability ─────────────────────────────────────────
  const products = wb.addWorksheet('Product Profitability');
  const productRows = ((itemProfRes.data ?? []) as {
    name: string; qty_sold: number; revenue_cents: number; cogs_cents: number; contribution_cents: number; contribution_margin_pct: number | null;
  }[])
    .slice()
    .sort((a, b) => b.revenue_cents - a.revenue_cents)
    .map((p) => ({
      item: p.name,
      units: p.qty_sold,
      revenue: centsToDollars(p.revenue_cents),
      cogs: centsToDollars(p.cogs_cents),
      contribution: centsToDollars(p.contribution_cents),
      margin_pct: p.contribution_margin_pct ?? null,
    }));
  addTable(
    products,
    [
      { header: 'Item', key: 'item', width: 26 },
      { header: 'Units', key: 'units', width: 10 },
      { header: 'Revenue', key: 'revenue', width: 12, style: { numFmt: MONEY_FMT } },
      { header: 'COGS', key: 'cogs', width: 12, style: { numFmt: MONEY_FMT } },
      { header: 'Contribution', key: 'contribution', width: 14, style: { numFmt: MONEY_FMT } },
      { header: 'Margin %', key: 'margin_pct', width: 10, style: { numFmt: PCT_FMT } },
    ],
    productRows,
    'No à la carte sales in this period.',
  );

  // ── 06 Deal Profitability ────────────────────────────────────────────
  const deals = wb.addWorksheet('Deal Profitability');
  const dealRows = ((dealProfRes.data ?? []) as {
    name: string; qty_sold: number; revenue_cents: number; cogs_cents: number; contribution_cents: number;
    contribution_margin_pct: number | null; list_value_cents: number | null; customer_saving_cents: number | null;
  }[]).map((d) => ({
    deal: d.name,
    units: d.qty_sold,
    revenue: centsToDollars(d.revenue_cents),
    list_value: centsToDollars(d.list_value_cents),
    customer_saving: centsToDollars(d.customer_saving_cents),
    cogs: centsToDollars(d.cogs_cents),
    contribution: centsToDollars(d.contribution_cents),
    margin_pct: d.contribution_margin_pct ?? null,
  }));
  addTable(
    deals,
    [
      { header: 'Deal', key: 'deal', width: 22 },
      { header: 'Units', key: 'units', width: 10 },
      { header: 'Revenue', key: 'revenue', width: 12, style: { numFmt: MONEY_FMT } },
      { header: 'À la carte value', key: 'list_value', width: 16, style: { numFmt: MONEY_FMT } },
      { header: 'Customer Saving', key: 'customer_saving', width: 16, style: { numFmt: MONEY_FMT } },
      { header: 'COGS', key: 'cogs', width: 12, style: { numFmt: MONEY_FMT } },
      { header: 'Contribution', key: 'contribution', width: 14, style: { numFmt: MONEY_FMT } },
      { header: 'Margin %', key: 'margin_pct', width: 10, style: { numFmt: PCT_FMT } },
    ],
    dealRows,
    'No deals sold in this period.',
  );

  // ── Promotions ───────────────────────────────────────────────────────
  const promotions = wb.addWorksheet('Promotions');
  const promoRows = ((promoRes.data ?? []) as {
    name: string; code: string | null; kind: string; redemptions: number;
    total_discount_cents: number; total_order_revenue_cents: number;
  }[]).map((p) => ({
    promotion: p.name,
    code: p.code ?? '—',
    kind: p.kind,
    redemptions: p.redemptions,
    discount_given: centsToDollars(p.total_discount_cents),
    order_revenue: centsToDollars(p.total_order_revenue_cents),
  }));
  addTable(
    promotions,
    [
      { header: 'Promotion', key: 'promotion', width: 22 },
      { header: 'Code', key: 'code', width: 12 },
      { header: 'Kind', key: 'kind', width: 10 },
      { header: 'Redemptions', key: 'redemptions', width: 12 },
      { header: 'Discount Given', key: 'discount_given', width: 14, style: { numFmt: MONEY_FMT } },
      { header: 'Order Revenue', key: 'order_revenue', width: 14, style: { numFmt: MONEY_FMT } },
    ],
    promoRows,
    'No promotions redeemed in this period.',
  );

  // ── 07 Purchasing ────────────────────────────────────────────────────
  const purchasing = wb.addWorksheet('Purchasing');
  const poRows = ((poRes.data ?? []) as {
    po_number: number; status: string; created_at: string; expected_at: string | null; received_at: string | null;
    subtotal_cents: number; suppliers: { name: string } | { name: string }[] | null;
  }[]).map((p) => ({
    po_number: p.po_number,
    supplier: one(p.suppliers)?.name ?? '—',
    status: p.status,
    created: p.created_at.slice(0, 10),
    expected: p.expected_at ?? '—',
    received: p.received_at ? p.received_at.slice(0, 10) : '—',
    subtotal: centsToDollars(p.subtotal_cents),
  }));
  addTable(
    purchasing,
    [
      { header: 'PO #', key: 'po_number', width: 10 },
      { header: 'Supplier', key: 'supplier', width: 20 },
      { header: 'Status', key: 'status', width: 12 },
      { header: 'Created', key: 'created', width: 12 },
      { header: 'Expected', key: 'expected', width: 12 },
      { header: 'Received', key: 'received', width: 12 },
      { header: 'Subtotal', key: 'subtotal', width: 12, style: { numFmt: MONEY_FMT } },
    ],
    poRows,
    'No purchase orders created in this period.',
  );

  // ── 08 Accounts Payable ──────────────────────────────────────────────
  const ap = wb.addWorksheet('Accounts Payable');
  const apRows = ((payableRes.data ?? []) as {
    supplier_name: string; invoiced_cents: number; on_hold_cents: number; approved_cents: number;
    paid_cents: number; credited_cents: number; outstanding_cents: number; overdue_cents: number;
  }[])
    .filter((r) => r.invoiced_cents > 0)
    .sort((a, b) => b.outstanding_cents - a.outstanding_cents)
    .map((r) => ({
      supplier: r.supplier_name,
      invoiced: centsToDollars(r.invoiced_cents),
      approved: centsToDollars(r.approved_cents),
      paid: centsToDollars(r.paid_cents),
      on_hold: centsToDollars(r.on_hold_cents),
      credited: centsToDollars(r.credited_cents),
      outstanding: centsToDollars(r.outstanding_cents),
      overdue: centsToDollars(r.overdue_cents),
    }));
  addTable(
    ap,
    [
      { header: 'Supplier', key: 'supplier', width: 20 },
      { header: 'Invoiced', key: 'invoiced', width: 12, style: { numFmt: MONEY_FMT } },
      { header: 'Approved', key: 'approved', width: 12, style: { numFmt: MONEY_FMT } },
      { header: 'Paid', key: 'paid', width: 12, style: { numFmt: MONEY_FMT } },
      { header: 'On Hold', key: 'on_hold', width: 12, style: { numFmt: MONEY_FMT } },
      { header: 'Credited', key: 'credited', width: 12, style: { numFmt: MONEY_FMT } },
      { header: 'Outstanding', key: 'outstanding', width: 14, style: { numFmt: MONEY_FMT } },
      { header: 'Overdue', key: 'overdue', width: 12, style: { numFmt: MONEY_FMT } },
    ],
    apRows,
    'No supplier invoices recorded yet.',
  );

  // ── 09 Supplier Payments ─────────────────────────────────────────────
  const payments = wb.addWorksheet('Supplier Payments');
  const paymentRows = ((paymentsRes.data ?? []) as {
    paid_at: string; amount_cents: number; method: string; reference: string | null; note: string | null; suppliers: { name: string } | { name: string }[] | null;
  }[]).map((p) => ({
    date: p.paid_at.slice(0, 10),
    supplier: one(p.suppliers)?.name ?? '—',
    amount: centsToDollars(p.amount_cents),
    method: p.method,
    reference: p.reference ?? '—',
  }));
  addTable(
    payments,
    [
      { header: 'Date', key: 'date', width: 12 },
      { header: 'Supplier', key: 'supplier', width: 20 },
      { header: 'Amount', key: 'amount', width: 12, style: { numFmt: MONEY_FMT } },
      { header: 'Method', key: 'method', width: 14 },
      { header: 'Reference', key: 'reference', width: 16 },
    ],
    paymentRows,
    'No supplier payments made in this period.',
  );

  // ── Supplier Performance — fill rate/on-time/lead time, not price alone
  // (spec §6). Not period-scoped (reflects all-time purchase order history
  // per supplier, same as get_supplier_performance answers in chat). ─────
  const supplierPerf = wb.addWorksheet('Supplier Performance');
  const supplierPerfRows = ((supplierPerfRaw as {
    suppliers: {
      supplier: string; catalog_items?: number; fill_rate_pct: number | null; rejected_qty: number;
      on_time_pct: number | null; avg_lead_time_days: number | null; deliveries: number;
    }[];
  }).suppliers).map((s) => ({
    supplier: s.supplier,
    catalog_items: s.catalog_items ?? 0,
    deliveries: s.deliveries,
    fill_rate_pct: s.fill_rate_pct,
    rejected_qty: s.rejected_qty,
    on_time_pct: s.on_time_pct,
    avg_lead_time_days: s.avg_lead_time_days,
  }));
  addTable(
    supplierPerf,
    [
      { header: 'Supplier', key: 'supplier', width: 20 },
      { header: 'Catalog Items', key: 'catalog_items', width: 12 },
      { header: 'Deliveries', key: 'deliveries', width: 10 },
      { header: 'Fill Rate %', key: 'fill_rate_pct', width: 12, style: { numFmt: PCT_FMT } },
      { header: 'Rejected Qty', key: 'rejected_qty', width: 12 },
      { header: 'On-Time %', key: 'on_time_pct', width: 10, style: { numFmt: PCT_FMT } },
      { header: 'Avg Lead Time (days)', key: 'avg_lead_time_days', width: 16 },
    ],
    supplierPerfRows,
    'No purchase order or catalog activity found.',
  );

  // ── 10 Inventory ─────────────────────────────────────────────────────
  const inv = wb.addWorksheet('Inventory');
  const invRows = ((invRes.data ?? []) as { name: string; unit: string; stock_qty: number; min_threshold: number; cost_cents_per_base_unit: number }[])
    .map((i) => ({
      item: i.name,
      unit: i.unit,
      on_hand: Number(i.stock_qty),
      min_threshold: Number(i.min_threshold),
      unit_cost: Math.round(Number(i.cost_cents_per_base_unit)) / 100,
      value: Math.round(Number(i.stock_qty) * Number(i.cost_cents_per_base_unit)) / 100,
      low_stock: Number(i.stock_qty) <= Number(i.min_threshold) ? 'Yes' : 'No',
    }))
    .sort((a, b) => b.value - a.value);
  addTable(
    inv,
    [
      { header: 'Item', key: 'item', width: 22 },
      { header: 'Unit', key: 'unit', width: 8 },
      { header: 'On Hand', key: 'on_hand', width: 12 },
      { header: 'Min Threshold', key: 'min_threshold', width: 14 },
      { header: 'Unit Cost', key: 'unit_cost', width: 12, style: { numFmt: '$#,##0.0000' } },
      { header: 'Value', key: 'value', width: 12, style: { numFmt: MONEY_FMT } },
      { header: 'Low Stock', key: 'low_stock', width: 10 },
    ],
    invRows,
  );

  // ── 11 Expenses ──────────────────────────────────────────────────────
  const expenses = wb.addWorksheet('Expenses');
  const expenseRows = ((expensesRes.data ?? []) as { expense_date: string; category: string; description: string | null; amount_cents: number }[]).map((e) => ({
    date: e.expense_date,
    category: e.category,
    description: e.description ?? '—',
    amount: centsToDollars(e.amount_cents),
  }));
  addTable(
    expenses,
    [
      { header: 'Date', key: 'date', width: 12 },
      { header: 'Category', key: 'category', width: 18 },
      { header: 'Description', key: 'description', width: 30 },
      { header: 'Amount', key: 'amount', width: 12, style: { numFmt: MONEY_FMT } },
    ],
    expenseRows,
    'No expense records dated in this period.',
  );

  // ── 12 Management Activity ───────────────────────────────────────────
  const ownerActivity = ownerActivityRaw as {
    purchasing: { purchase_orders_created: number; purchase_orders_received: number };
    suppliers: { price_updates: number; payments_made: number; payments_total_cents: number; invoices_recorded: number; payment_holds_resolved: number };
    inventory: { stock_adjustments: number; stock_counts: number; low_stock_events_opened: number };
    menu: { items_added: number; updates: number; price_changes: number; made_unavailable: number };
    promotions: { created: number };
    expenses: { recorded: number; total_cents: number };
    staff: { attendance_marks: number; schedule_changes: number };
  };
  const activitySheet = wb.addWorksheet('Management Activity');
  activitySheet.columns = [{ width: 30 }, { width: 16 }];
  const activityRows: [string, number | string][] = [
    ['Purchase Orders Created', ownerActivity.purchasing.purchase_orders_created],
    ['Purchase Orders Received', ownerActivity.purchasing.purchase_orders_received],
    ['Supplier Price Updates', ownerActivity.suppliers.price_updates],
    ['Supplier Payments Made', ownerActivity.suppliers.payments_made],
    ['Supplier Payments Total', centsToDollars(ownerActivity.suppliers.payments_total_cents)!],
    ['Supplier Invoices Recorded', ownerActivity.suppliers.invoices_recorded],
    ['Payment Holds Resolved', ownerActivity.suppliers.payment_holds_resolved],
    ['Stock Adjustments', ownerActivity.inventory.stock_adjustments],
    ['Stock Counts', ownerActivity.inventory.stock_counts],
    ['Low-Stock Events Opened', ownerActivity.inventory.low_stock_events_opened],
    ['Menu Items Added', ownerActivity.menu.items_added],
    ['Menu Updates', ownerActivity.menu.updates],
    ['Menu Price Changes', ownerActivity.menu.price_changes],
    ['Items Made Unavailable', ownerActivity.menu.made_unavailable],
    ['Promotions Created', ownerActivity.promotions.created],
    ['Expenses Recorded', ownerActivity.expenses.recorded],
    ['Expenses Total', centsToDollars(ownerActivity.expenses.total_cents)!],
    ['Attendance Marks', ownerActivity.staff.attendance_marks],
    ['Schedule Changes', ownerActivity.staff.schedule_changes],
  ];
  const actHeader = activitySheet.addRow(['Action', 'Count / Amount']);
  styleHeaderRow(actHeader);
  for (const [labelText, value] of activityRows) {
    const r = activitySheet.addRow([labelText, value]);
    if (labelText.includes('Total')) r.getCell(2).numFmt = MONEY_FMT;
    r.getCell(1).font = { color: { argb: 'FF64748B' } };
    r.getCell(2).font = { bold: true };
  }

  // ── AI Actions — every AI-proposed action in this period, its approval
  // outcome and who resolved it (spec §32). Real audit rows from
  // ai_pending_actions, never a reconstructed log. ────────────────────────
  const aiActions = wb.addWorksheet('AI Actions');
  const aiActionRows = ((aiActionsRes.data ?? []) as {
    action_name: string; status: string; summary: string; proposed_by_email: string | null; proposed_by_role: string | null;
    created_at: string; resolved_at: string | null; resolved_by_email: string | null; result: unknown; error: string | null;
  }[]).map((a) => ({
    action: a.action_name,
    status: a.status,
    summary: a.summary,
    proposed_by: a.proposed_by_email ?? '—',
    role: a.proposed_by_role ?? '—',
    created_at: a.created_at.slice(0, 19).replace('T', ' '),
    resolved_at: a.resolved_at ? a.resolved_at.slice(0, 19).replace('T', ' ') : '—',
    resolved_by: a.resolved_by_email ?? '—',
    error: a.error ?? '—',
  }));
  addTable(
    aiActions,
    [
      { header: 'Action', key: 'action', width: 18 },
      { header: 'Status', key: 'status', width: 12 },
      { header: 'Summary', key: 'summary', width: 40 },
      { header: 'Proposed By', key: 'proposed_by', width: 22 },
      { header: 'Role', key: 'role', width: 10 },
      { header: 'Proposed At', key: 'created_at', width: 18 },
      { header: 'Resolved At', key: 'resolved_at', width: 18 },
      { header: 'Resolved By', key: 'resolved_by', width: 22 },
      { header: 'Error', key: 'error', width: 20 },
    ],
    aiActionRows,
    'No AI-proposed actions in this period.',
  );

  // ── 13 Verification (spec §33) ───────────────────────────────────────
  const verification = wb.addWorksheet('Verification');
  const netSalesCheck = profit.gross_sales_cents - profit.discount_cents - profit.refunded_cents === profit.net_sales_cents;
  const grossProfitCheck = profit.net_sales_cents - profit.theoretical_cogs_cents === profit.gross_profit_cents;
  const netProfitCheck = profit.gross_profit_cents - profit.expenses_cents === profit.net_profit_cents;
  const attentionCount = attentionItems.length;
  const verificationRows = [
    { check: 'Net Sales = Gross Sales - Discounts - Refunds', result: netSalesCheck ? 'PASS' : 'FAIL', detail: `${centsToDollars(profit.gross_sales_cents)} - ${centsToDollars(profit.discount_cents)} - ${centsToDollars(profit.refunded_cents)} = ${centsToDollars(profit.net_sales_cents)}` },
    { check: 'Gross Profit = Net Sales - COGS', result: grossProfitCheck ? 'PASS' : 'FAIL', detail: `${centsToDollars(profit.net_sales_cents)} - ${centsToDollars(profit.theoretical_cogs_cents)} = ${centsToDollars(profit.gross_profit_cents)}` },
    { check: 'Net Profit = Gross Profit - Expenses', result: netProfitCheck ? 'PASS' : 'FAIL', detail: `${centsToDollars(profit.gross_profit_cents)} - ${centsToDollars(profit.expenses_cents)} = ${centsToDollars(profit.net_profit_cents)}` },
    {
      check: 'Recipe coverage on sold lines',
      result: profit.cogs_lines_missing === 0 ? 'PASS' : 'REVIEW',
      detail: profit.cogs_lines_missing === 0 ? 'Every sold line had a recipe configured.' : `${profit.cogs_lines_missing} of ${profit.cogs_lines_total} sold line(s) have no recipe — COGS understates the true figure.`,
    },
    {
      check: 'Theoretical vs actual COGS variance',
      result: Math.abs(profit.cogs_variance_cents) === 0 ? 'PASS' : 'REVIEW',
      detail: `Actual (ledger) COGS ${centsToDollars(profit.actual_cogs_cents)} vs theoretical (recipe) COGS ${centsToDollars(profit.theoretical_cogs_cents)}.`,
    },
    {
      check: 'Attention items open',
      result: attentionCount === 0 ? 'PASS' : 'REVIEW',
      detail: attentionCount === 0 ? 'No open exceptions.' : `${attentionCount} open exception(s) — see get_attention_items / the Attention page for detail.`,
    },
    { check: 'Labor/payroll cost', result: 'REVIEW', detail: 'Not separately tracked — only reflected in Net Profit if entered as an expense record.' },
  ];
  addTable(
    verification,
    [
      { header: 'Check', key: 'check', width: 40 },
      { header: 'Result', key: 'result', width: 10 },
      { header: 'Detail', key: 'detail', width: 60 },
    ],
    verificationRows,
  );
  verification.eachRow((row, num) => {
    if (num === 1) return;
    const cell = row.getCell(2);
    if (cell.value === 'PASS') cell.font = { color: { argb: 'FF16A34A' }, bold: true };
    else if (cell.value === 'FAIL') cell.font = { color: { argb: 'FFDC2626' }, bold: true };
    else if (cell.value === 'REVIEW') cell.font = { color: { argb: 'FFD97706' }, bold: true };
  });

  if (includeSheets && includeSheets.length > 0) {
    const keep = new Set([...EXCEL_ANCHOR_SHEETS, ...includeSheets]);
    for (const sheet of [...wb.worksheets]) {
      if (!keep.has(sheet.name)) wb.removeWorksheet(sheet.id);
    }
  }

  return { ok: true, workbook: wb, periodLabel: label };
}
