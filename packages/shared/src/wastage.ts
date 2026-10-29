/**
 * Wastage calculations shared by the portal (Wastage screen) and the API (AI
 * tools). Pure functions over the figures public.wastage_report() returns
 * (tenant-migrations/0109) — no database access, no guessing: a missing cost
 * or an empty denominator gives null, never a made-up number.
 *
 *   Waste cost       = wasted quantity × the unit cost it was recorded at
 *   Waste rate (%)   = waste cost ÷ inventory consumed value × 100
 *                      (consumed value = recipe usage + recorded waste, at cost)
 *   Expected closing = opening + receipts + adjustments in − recipe usage
 *                      − recorded waste − other outflows
 *   Variance         = actual closing − expected closing
 *                      (only physical stock counts make this non-zero; it is
 *                      unexplained loss or gain, kept apart from recorded waste)
 */

export const WASTE_REASONS = ['expiry', 'spoilage', 'preparation', 'cooking_error', 'overproduction', 'spillage', 'other'] as const;
export type WasteReason = (typeof WASTE_REASONS)[number];

export const WASTE_REASON_LABELS: Record<WasteReason | 'unclassified', string> = {
  expiry: 'Expired',
  spoilage: 'Spoiled',
  preparation: 'Preparation waste',
  cooking_error: 'Cooking error',
  overproduction: 'Overproduction',
  spillage: 'Spillage',
  other: 'Other',
  unclassified: 'Not classified',
};

export function isWasteReason(v: unknown): v is WasteReason {
  return typeof v === 'string' && (WASTE_REASONS as readonly string[]).includes(v);
}

// ── Units (mirrors app.waste_unit_factor in SQL) ───────────────────────────
const METRIC: Record<string, ['weight' | 'volume', number]> = {
  mg: ['weight', 0.001], g: ['weight', 1], gm: ['weight', 1], gram: ['weight', 1], grams: ['weight', 1],
  kg: ['weight', 1000], kgs: ['weight', 1000], kilo: ['weight', 1000], kilogram: ['weight', 1000], kilograms: ['weight', 1000],
  ml: ['volume', 1], millilitre: ['volume', 1], milliliter: ['volume', 1],
  l: ['volume', 1000], ltr: ['volume', 1000], litre: ['volume', 1000], liter: ['volume', 1000], litres: ['volume', 1000], liters: ['volume', 1000],
};

export type WasteUnitItem = { unit: string; purchase_unit_label?: string | null; purchase_unit_to_base?: number | string | null };
export type WasteUnitOption = { unit: string; factor: number };

/** How many base units one `unit` is, or null when it can't be converted. */
export function wasteUnitFactor(item: WasteUnitItem, unit: string | null | undefined): number | null {
  const u = String(unit ?? '').trim().toLowerCase();
  const base = String(item.unit ?? '').trim().toLowerCase();
  if (!u || u === base) return 1;
  const purchase = String(item.purchase_unit_label ?? '').trim().toLowerCase();
  const pf = Number(item.purchase_unit_to_base);
  if (purchase && u === purchase && pf > 0) return pf;
  const a = METRIC[u];
  const b = METRIC[base];
  if (a && b && a[0] === b[0]) return a[1] / b[1];
  return null;
}

/** The units a waste entry may be entered in: base unit, purchase unit, metric relatives. */
export function wasteUnitOptions(item: WasteUnitItem): WasteUnitOption[] {
  const out: WasteUnitOption[] = [{ unit: item.unit, factor: 1 }];
  const add = (unit: string) => {
    const f = wasteUnitFactor(item, unit);
    if (f !== null && !out.some((o) => o.unit.toLowerCase() === unit.toLowerCase())) out.push({ unit, factor: f });
  };
  if (item.purchase_unit_label) add(item.purchase_unit_label);
  const fam = METRIC[String(item.unit).trim().toLowerCase()]?.[0];
  if (fam === 'weight') ['g', 'kg'].forEach(add);
  if (fam === 'volume') ['ml', 'L'].forEach(add);
  return out;
}

/** Quantity in base units, rounded like numeric(14,3); null when not convertible or not positive. */
export function toBaseQty(item: WasteUnitItem, qty: number, unit: string | null | undefined): number | null {
  const f = wasteUnitFactor(item, unit);
  if (f === null || !Number.isFinite(qty) || qty <= 0) return null;
  const base = Math.round(qty * f * 1000) / 1000;
  return base > 0 ? base : null;
}

// ── Report shapes (what wastage_report() returns) ──────────────────────────
export type WastageItemRow = {
  inventory_item_id: string;
  name: string;
  unit: string;
  opening_qty: number;
  closing_qty: number;
  receipts_qty: number;
  adjust_in_qty: number;
  adjust_out_qty: number;
  usage_qty: number;
  waste_qty: number;
  stock_take_qty: number;
  waste_after_use_qty: number;
  usage_value_cents: number | null;
  waste_cost_cents: number | null;
  waste_after_use_cost_cents: number | null;
  unit_cost_cents: number | null;
  estimated_cost_rows: number;
};
export type WastageDailyRow = { day: string; events: number; cost_cents: number | null };
export type WastageReasonRow = { inventory_item_id: string; reason: string; qty: number; cost_cents: number | null };
export type WastageReport = {
  from: string;
  to: string;
  branch_id: string | null;
  costs_visible: boolean;
  items: WastageItemRow[];
  daily: WastageDailyRow[];
  by_item_reason: WastageReasonRow[];
};

const num = (v: unknown) => (v === null || v === undefined || v === '' ? 0 : Number(v) || 0);
const numOrNull = (v: unknown) => (v === null || v === undefined || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null);
const r3 = (n: number) => Math.round(n * 1000) / 1000;

/** Coerce the RPC's JSON (numerics arrive as numbers or strings) into a WastageReport. */
export function parseWastageReport(raw: unknown): WastageReport {
  const o = (raw ?? {}) as Record<string, unknown>;
  const arr = (v: unknown) => (Array.isArray(v) ? (v as Record<string, unknown>[]) : []);
  return {
    from: String(o.from ?? ''),
    to: String(o.to ?? ''),
    branch_id: (o.branch_id as string | null) ?? null,
    costs_visible: o.costs_visible === true,
    items: arr(o.items).map((i) => ({
      inventory_item_id: String(i.inventory_item_id),
      name: String(i.name ?? '—'),
      unit: String(i.unit ?? ''),
      opening_qty: num(i.opening_qty),
      closing_qty: num(i.closing_qty),
      receipts_qty: num(i.receipts_qty),
      adjust_in_qty: num(i.adjust_in_qty),
      adjust_out_qty: num(i.adjust_out_qty),
      usage_qty: num(i.usage_qty),
      waste_qty: num(i.waste_qty),
      stock_take_qty: num(i.stock_take_qty),
      waste_after_use_qty: num(i.waste_after_use_qty),
      usage_value_cents: numOrNull(i.usage_value_cents),
      waste_cost_cents: numOrNull(i.waste_cost_cents),
      waste_after_use_cost_cents: numOrNull(i.waste_after_use_cost_cents),
      unit_cost_cents: numOrNull(i.unit_cost_cents),
      estimated_cost_rows: num(i.estimated_cost_rows),
    })),
    daily: arr(o.daily).map((d) => ({ day: String(d.day), events: num(d.events), cost_cents: numOrNull(d.cost_cents) })),
    by_item_reason: arr(o.by_item_reason).map((r) => ({
      inventory_item_id: String(r.inventory_item_id),
      reason: String(r.reason ?? 'unclassified'),
      qty: num(r.qty),
      cost_cents: numOrNull(r.cost_cents),
    })),
  };
}

// ── Calculations ────────────────────────────────────────────────────────────
/** Waste ÷ consumed × 100, one decimal; null when either is unknown or nothing was consumed. */
export function wasteRatePct(wasteCents: number | null, consumedCents: number | null): number | null {
  if (wasteCents === null || consumedCents === null || !(consumedCents > 0)) return null;
  return Math.round((wasteCents / consumedCents) * 1000) / 10;
}

export function expectedClosingQty(i: Pick<WastageItemRow, 'opening_qty' | 'receipts_qty' | 'adjust_in_qty' | 'usage_qty' | 'waste_qty' | 'adjust_out_qty'>): number {
  return r3(i.opening_qty + i.receipts_qty + i.adjust_in_qty - i.usage_qty - i.waste_qty - i.adjust_out_qty);
}

export function inventoryVarianceQty(i: WastageItemRow): number {
  return r3(i.closing_qty - expectedClosingQty(i));
}

export type IngredientWaste = {
  inventory_item_id: string;
  name: string;
  unit: string;
  /** Recorded waste: stock taken out as waste plus waste of food orders had already used. */
  waste_qty: number;
  waste_cost_cents: number | null;
  /** Of which: food orders had already used (no second stock deduction). */
  waste_after_use_qty: number;
  consumed_value_cents: number | null;
  waste_rate_pct: number | null;
  receipts_qty: number;
  usage_qty: number;
  opening_qty: number;
  expected_closing_qty: number;
  closing_qty: number;
  /** Actual − expected: unexplained (stock counts), never part of recorded waste. */
  variance_qty: number;
  variance_cost_cents: number | null;
  top_reason: string | null;
  cost_estimated: boolean;
};

export type WastageSummary = {
  total_waste_cost_cents: number | null;
  consumed_value_cents: number | null;
  waste_rate_pct: number | null;
  /** Value of unexplained stock-count differences (negative = stock missing). */
  unexplained_variance_cents: number | null;
  entries: number;
  ingredients: IngredientWaste[];
  by_reason: { reason: string; label: string; qty_lines: number; cost_cents: number | null }[];
  cost_estimated_rows: number;
};

export function summarizeWastage(report: WastageReport): WastageSummary {
  const costs = report.costs_visible;
  const reasonsByItem = new Map<string, WastageReasonRow[]>();
  for (const r of report.by_item_reason) {
    const list = reasonsByItem.get(r.inventory_item_id) ?? [];
    list.push(r);
    reasonsByItem.set(r.inventory_item_id, list);
  }

  const ingredients: IngredientWaste[] = report.items.map((i) => {
    const wasteCost = costs && i.waste_cost_cents !== null ? i.waste_cost_cents + (i.waste_after_use_cost_cents ?? 0) : null;
    // Food an order already used is already inside usage value — not added twice.
    const consumed = costs && i.usage_value_cents !== null && i.waste_cost_cents !== null ? i.usage_value_cents + i.waste_cost_cents : null;
    const variance = inventoryVarianceQty(i);
    const top = (reasonsByItem.get(i.inventory_item_id) ?? [])
      .filter((r) => r.qty > 0)
      .sort((a, b) => (b.cost_cents ?? b.qty) - (a.cost_cents ?? a.qty))[0];
    return {
      inventory_item_id: i.inventory_item_id,
      name: i.name,
      unit: i.unit,
      waste_qty: r3(i.waste_qty + i.waste_after_use_qty),
      waste_cost_cents: wasteCost,
      waste_after_use_qty: i.waste_after_use_qty,
      consumed_value_cents: consumed,
      waste_rate_pct: wasteRatePct(wasteCost, consumed),
      receipts_qty: i.receipts_qty,
      usage_qty: i.usage_qty,
      opening_qty: i.opening_qty,
      expected_closing_qty: expectedClosingQty(i),
      closing_qty: i.closing_qty,
      variance_qty: variance,
      variance_cost_cents: costs && i.unit_cost_cents !== null ? Math.round(variance * i.unit_cost_cents) : null,
      top_reason: top?.reason ?? null,
      cost_estimated: i.estimated_cost_rows > 0,
    };
  });

  const sumOrNull = (vals: (number | null)[]) => (costs ? vals.reduce<number>((s, v) => s + (v ?? 0), 0) : null);
  const total = sumOrNull(ingredients.map((i) => i.waste_cost_cents));
  const consumed = sumOrNull(ingredients.map((i) => i.consumed_value_cents));

  const reasonMap = new Map<string, { qty_lines: number; cost: number }>();
  for (const r of report.by_item_reason) {
    const cur = reasonMap.get(r.reason) ?? { qty_lines: 0, cost: 0 };
    cur.qty_lines += 1;
    cur.cost += r.cost_cents ?? 0;
    reasonMap.set(r.reason, cur);
  }
  const by_reason = [...reasonMap.entries()]
    .map(([reason, v]) => ({
      reason,
      label: WASTE_REASON_LABELS[reason as WasteReason] ?? reason,
      qty_lines: v.qty_lines,
      cost_cents: costs ? Math.round(v.cost) : null,
    }))
    .filter((r) => r.cost_cents === null || r.cost_cents !== 0)
    .sort((a, b) => (b.cost_cents ?? 0) - (a.cost_cents ?? 0));

  return {
    total_waste_cost_cents: total,
    consumed_value_cents: consumed,
    waste_rate_pct: wasteRatePct(total, consumed),
    unexplained_variance_cents: sumOrNull(ingredients.map((i) => i.variance_cost_cents)),
    entries: report.daily.reduce((s, d) => s + d.events, 0),
    ingredients: ingredients
      .filter((i) => i.waste_qty !== 0 || i.variance_qty !== 0)
      .sort((a, b) => (b.waste_cost_cents ?? b.waste_qty) - (a.waste_cost_cents ?? a.waste_qty)),
    by_reason,
    cost_estimated_rows: report.items.reduce((s, i) => s + i.estimated_cost_rows, 0),
  };
}

// ── Trends ─────────────────────────────────────────────────────────────────
export type TrendGrain = 'day' | 'week' | 'month';

/** Monday of the ISO week a YYYY-MM-DD falls in. */
export function weekStart(ymd: string): string {
  const d = new Date(`${ymd}T00:00:00Z`);
  const dow = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - dow);
  return d.toISOString().slice(0, 10);
}

/** Daily waste cost grouped by day, ISO week (Monday) or month; every bucket in range, zeros included. */
export function wasteTrend(daily: WastageDailyRow[], from: string, to: string, grain: TrendGrain): { bucket: string; cost_cents: number | null; events: number }[] {
  const key = (ymd: string) => (grain === 'day' ? ymd : grain === 'week' ? weekStart(ymd) : ymd.slice(0, 7));
  const buckets = new Map<string, { cost: number | null; events: number }>();
  for (let d = new Date(`${from}T00:00:00Z`); d.toISOString().slice(0, 10) <= to; d.setUTCDate(d.getUTCDate() + 1)) {
    const k = key(d.toISOString().slice(0, 10));
    if (!buckets.has(k)) buckets.set(k, { cost: 0, events: 0 });
    if (buckets.size > 800) break;
  }
  for (const row of daily) {
    const b = buckets.get(key(row.day));
    if (!b) continue;
    b.events += row.events;
    b.cost = row.cost_cents === null || b.cost === null ? null : b.cost + row.cost_cents;
  }
  return [...buckets.entries()].map(([bucket, v]) => ({ bucket, cost_cents: v.cost === null ? null : Math.round(v.cost), events: v.events }));
}

// ── Rules-based alerts ─────────────────────────────────────────────────────
export type WasteAlert = {
  kind: 'rising_waste' | 'high_waste_rate' | 'unexplained_loss' | 'over_purchasing';
  severity: 'warn' | 'danger';
  inventory_item_id: string;
  name: string;
  message: string;
  current_cents?: number | null;
  previous_cents?: number | null;
  rate_pct?: number | null;
};

export type AlertOptions = {
  /** Smallest change worth flagging, in cents (default 500 = 5.00). */
  minChangeCents?: number;
  /** Rise vs the previous period that counts as unusual (default 50%). */
  risePct?: number;
  /** Waste rate that counts as high (default 10%). */
  highRatePct?: number;
  format?: (cents: number) => string;
};

/**
 * Plain rules, no forecasting:
 *  - rising: waste cost up ≥ risePct vs the previous period and by ≥ minChangeCents;
 *  - high rate: ≥ highRatePct of what the ingredient consumed was wasted;
 *  - unexplained loss: a stock count found less than the records say (not waste);
 *  - over-purchasing: expired/spoiled waste ≥ 15% of what was received in the period.
 */
export function wasteAlerts(current: WastageSummary, previous: WastageSummary | null, opts: AlertOptions = {}): WasteAlert[] {
  const minChange = opts.minChangeCents ?? 500;
  const rise = opts.risePct ?? 50;
  const high = opts.highRatePct ?? 10;
  const fmt = opts.format ?? ((c: number) => (c / 100).toFixed(2));
  const prevBy = new Map((previous?.ingredients ?? []).map((i) => [i.inventory_item_id, i]));
  const out: WasteAlert[] = [];

  for (const i of current.ingredients) {
    const cur = i.waste_cost_cents;
    const prev = prevBy.get(i.inventory_item_id)?.waste_cost_cents ?? (previous ? 0 : null);
    if (cur !== null && prev !== null && cur - prev >= minChange && (prev === 0 || ((cur - prev) / prev) * 100 >= rise)) {
      out.push({
        kind: 'rising_waste',
        severity: prev === 0 || cur >= prev * 2 ? 'danger' : 'warn',
        inventory_item_id: i.inventory_item_id,
        name: i.name,
        current_cents: cur,
        previous_cents: prev,
        message:
          prev === 0
            ? `${i.name}: ${fmt(cur)} wasted, none in the previous period.`
            : `${i.name}: waste up ${Math.round(((cur - prev) / prev) * 100)}% (${fmt(prev)} → ${fmt(cur)}).`,
      });
    }
    const rising = out.find((a) => a.kind === 'rising_waste' && a.inventory_item_id === i.inventory_item_id);
    if (rising && i.usage_qty <= 0) {
      // One line per ingredient: "none used in orders" belongs with the rise it explains.
      rising.message = rising.message.replace(/\.$/, '; none was used in orders.');
    } else if (i.waste_rate_pct !== null && i.waste_rate_pct >= high && (cur ?? 0) >= minChange / 5) {
      out.push({
        kind: 'high_waste_rate',
        severity: i.waste_rate_pct >= high * 2 ? 'danger' : 'warn',
        inventory_item_id: i.inventory_item_id,
        name: i.name,
        rate_pct: i.waste_rate_pct,
        message:
          i.usage_qty > 0
            ? `${i.name}: ${i.waste_rate_pct}% of what was used was wasted.`
            : `${i.name}: wasted, but none was used in orders this period.`,
      });
    }
    if (i.variance_qty < 0) {
      out.push({
        kind: 'unexplained_loss',
        severity: 'warn',
        inventory_item_id: i.inventory_item_id,
        name: i.name,
        current_cents: i.variance_cost_cents,
        message: `${i.name}: a stock count found ${Math.abs(i.variance_qty)} ${i.unit} less than recorded — not logged as waste.`,
      });
    }
    const spoiled = i.top_reason === 'expiry' || i.top_reason === 'spoilage';
    if (spoiled && i.receipts_qty > 0 && i.waste_qty / i.receipts_qty >= 0.15) {
      out.push({
        kind: 'over_purchasing',
        severity: 'warn',
        inventory_item_id: i.inventory_item_id,
        name: i.name,
        message: `${i.name}: ${Math.round((i.waste_qty / i.receipts_qty) * 100)}% of what was received went off — consider smaller, more frequent orders.`,
      });
    }
  }
  const rank = { danger: 0, warn: 1 } as const;
  return out.sort((a, b) => rank[a.severity] - rank[b.severity]);
}

// ── Expiry (estimate: first in, first out over receipts) ───────────────────
export type Receipt = { received_at: string; qty: number };
export type ExpiryEstimate = {
  status: 'expired' | 'soon' | 'ok' | 'no_stock' | 'unknown';
  /** Stock estimated past its shelf life. */
  expired_qty: number;
  /** Stock reaching its shelf life within the window. */
  expiring_qty: number;
  /** Earliest estimated expiry of what is still in stock (ISO), null if all is older than the receipts seen. */
  next_expiry_at: string | null;
  days_left: number | null;
};

/**
 * Which of `stockQty` is getting old, assuming the oldest stock is used first.
 * Today's stock is made of the newest receipts; any stock beyond the receipts
 * given (all received within the shelf life window or more) is older than
 * every one of them and so is counted as past its shelf life — callers pass
 * every receipt from at least the last `shelfLifeDays` days.
 */
export function estimateExpiry(stockQty: number, receipts: Receipt[], shelfLifeDays: number, now: Date, withinDays = 3): ExpiryEstimate {
  if (!(stockQty > 0)) return { status: 'no_stock', expired_qty: 0, expiring_qty: 0, next_expiry_at: null, days_left: null };
  const DAY = 86_400_000;
  const windowEnd = now.getTime() + withinDays * DAY;
  const sorted = receipts.filter((r) => r.qty > 0).sort((a, b) => Date.parse(b.received_at) - Date.parse(a.received_at));
  // No receipt on record (stock entered by hand or imported): its age is unknown — say so, don't guess.
  if (sorted.length === 0) return { status: 'unknown', expired_qty: 0, expiring_qty: 0, next_expiry_at: null, days_left: null };
  let remaining = stockQty;
  let expired = 0;
  let expiring = 0;
  let next: number | null = null;
  for (const r of sorted) {
    if (remaining <= 0) break;
    const take = Math.min(remaining, r.qty);
    remaining -= take;
    const exp = Date.parse(r.received_at) + shelfLifeDays * DAY;
    if (exp <= now.getTime()) expired += take;
    else {
      if (exp <= windowEnd) expiring += take;
      next = next === null ? exp : Math.min(next, exp);
    }
  }
  if (remaining > 0) expired += remaining; // older than every receipt seen
  const status = expired > 0 ? 'expired' : expiring > 0 ? 'soon' : 'ok';
  return {
    status,
    expired_qty: r3(expired),
    expiring_qty: r3(expiring),
    next_expiry_at: next === null ? null : new Date(next).toISOString(),
    days_left: next === null ? null : Math.max(0, Math.ceil((next - now.getTime()) / DAY)),
  };
}

export type ExpiryRisk = ExpiryEstimate & { inventory_item_id: string; name: string; unit: string; stock_qty: number; shelf_life_days: number };

/**
 * Expiry estimates for every ingredient that has a shelf life, most urgent
 * first. `receipts` are stock_ledger 'restock' rows (positive delta) for those
 * ingredients from at least the longest shelf life ago.
 */
export function expiryRisks(
  items: { id: string; name: string; unit: string; stock_qty: number | string; shelf_life_days: number | null }[],
  receipts: { inventory_item_id: string; created_at: string; delta_qty: number | string }[],
  now: Date,
  withinDays = 3,
): ExpiryRisk[] {
  const by = new Map<string, Receipt[]>();
  for (const r of receipts) {
    const q = Number(r.delta_qty);
    if (!(q > 0)) continue;
    const list = by.get(r.inventory_item_id) ?? [];
    list.push({ received_at: r.created_at, qty: q });
    by.set(r.inventory_item_id, list);
  }
  const rank = { expired: 0, soon: 1, unknown: 2, ok: 3, no_stock: 4 } as const;
  return items
    .filter((i) => (i.shelf_life_days ?? 0) > 0)
    .map((i) => ({
      inventory_item_id: i.id,
      name: i.name,
      unit: i.unit,
      stock_qty: Number(i.stock_qty) || 0,
      shelf_life_days: Number(i.shelf_life_days),
      ...estimateExpiry(Number(i.stock_qty) || 0, by.get(i.id) ?? [], Number(i.shelf_life_days), now, withinDays),
    }))
    .sort((a, b) => rank[a.status] - rank[b.status] || (a.days_left ?? 1e9) - (b.days_left ?? 1e9));
}

/** Plain-language messages for the errors record/approve/reject/reverse raise. */
export function wasteErrorMessage(raw: string | null | undefined): string {
  const m = String(raw ?? '');
  if (/insufficient_stock/.test(m)) return 'There is not that much in stock. Check the quantity and unit.';
  if (/bad_unit/.test(m)) return 'That unit can’t be converted to how this ingredient is stocked.';
  if (/bad_qty/.test(m)) return 'Enter a quantity above zero.';
  if (/bad_reason/.test(m)) return 'Choose a reason.';
  if (/reason_required/.test(m)) return 'Add a note explaining the reason.';
  if (/bad_date/.test(m)) return 'The date must be today or within the last 31 days.';
  if (/not_used_by_order/.test(m)) return 'That order did not use this ingredient.';
  if (/exceeds_order_usage/.test(m)) return 'That is more than the order used of this ingredient.';
  if (/already_approved/.test(m)) return 'This entry was already approved.';
  if (/already_rejected/.test(m)) return 'This entry was already rejected.';
  if (/already_reversed|not_reversible/.test(m)) return 'Only an approved entry can be reversed, and only once.';
  if (/forbidden|insufficient_privilege|42501/.test(m)) return 'You don’t have permission to do this.';
  if (/wastage_report|waste_entries|record_waste_entry|PGRST202|PGRST205|42P01|42883/.test(m)) return 'Database update needed: tenant migration 0109 has not been applied yet.';
  return m || 'Something went wrong.';
}

/** True when the error means migration 0109 isn't on this restaurant's database yet. */
export function isWastageSchemaMissing(raw: string | null | undefined): boolean {
  return /wastage_report|waste_entries|record_waste_entry|inventory_shelf_life|PGRST202|PGRST205|42P01|42883|schema cache/i.test(String(raw ?? ''));
}
