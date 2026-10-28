// Run: npm test -w @automation-restaurant/shared
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  wasteUnitFactor,
  wasteUnitOptions,
  toBaseQty,
  wasteRatePct,
  expectedClosingQty,
  inventoryVarianceQty,
  parseWastageReport,
  summarizeWastage,
  wasteTrend,
  weekStart,
  wasteAlerts,
  estimateExpiry,
  expiryRisks,
  wasteErrorMessage,
  isWastageSchemaMissing,
  type WastageItemRow,
} from '../src/wastage';

const item = (over: Partial<WastageItemRow> = {}): WastageItemRow => ({
  inventory_item_id: 'chicken',
  name: 'Chicken',
  unit: 'g',
  opening_qty: 10000,
  closing_qty: 6500,
  receipts_qty: 5000,
  adjust_in_qty: 0,
  adjust_out_qty: 0,
  usage_qty: 7000,
  waste_qty: 1500,
  stock_take_qty: 0,
  waste_after_use_qty: 0,
  usage_value_cents: 70000,
  waste_cost_cents: 15000,
  waste_after_use_cost_cents: 0,
  unit_cost_cents: 10,
  estimated_cost_rows: 0,
  ...over,
});

test('units: base, purchase unit and metric relatives; unknown units rejected', () => {
  const chicken = { unit: 'g', purchase_unit_label: 'KG bag', purchase_unit_to_base: 1000 };
  assert.equal(wasteUnitFactor(chicken, 'g'), 1);
  assert.equal(wasteUnitFactor(chicken, null), 1);
  assert.equal(wasteUnitFactor(chicken, 'kg'), 1000);
  assert.equal(wasteUnitFactor(chicken, 'KG bag'), 1000);
  assert.equal(wasteUnitFactor(chicken, 'ml'), null); // weight ≠ volume
  assert.equal(wasteUnitFactor({ unit: 'kg' }, 'g'), 0.001);
  assert.equal(wasteUnitFactor({ unit: 'ml' }, 'L'), 1000);
  assert.equal(wasteUnitFactor({ unit: 'piece' }, 'kg'), null);
  assert.deepEqual(wasteUnitOptions(chicken).map((o) => o.unit), ['g', 'KG bag', 'kg']);
  assert.equal(toBaseQty(chicken, 1.25, 'kg'), 1250);
  assert.equal(toBaseQty(chicken, 0, 'kg'), null);
  assert.equal(toBaseQty(chicken, -2, 'g'), null);
  assert.equal(toBaseQty({ unit: 'piece' }, 2, 'kg'), null);
});

test('waste rate handles zero and unknown denominators', () => {
  assert.equal(wasteRatePct(1500, 10000), 15);
  assert.equal(wasteRatePct(1, 3), 33.3);
  assert.equal(wasteRatePct(500, 0), null);
  assert.equal(wasteRatePct(null, 100), null);
  assert.equal(wasteRatePct(100, null), null);
});

test('expected closing and variance keep recorded waste apart from unexplained loss', () => {
  const i = item();
  // 10000 + 5000 − 7000 − 1500 = 6500
  assert.equal(expectedClosingQty(i), 6500);
  assert.equal(inventoryVarianceQty(i), 0);
  // A stock count found 200 g less: closing is 200 lower, waste is unchanged.
  const counted = item({ closing_qty: 6300, stock_take_qty: -200 });
  assert.equal(inventoryVarianceQty(counted), -200);
  const s = summarizeWastage({ from: '2026-10-01', to: '2026-10-28', branch_id: null, costs_visible: true, items: [counted], daily: [], by_item_reason: [] });
  assert.equal(s.ingredients[0].waste_qty, 1500);
  assert.equal(s.ingredients[0].variance_cost_cents, -2000);
  assert.equal(s.unexplained_variance_cents, -2000);
  assert.equal(s.total_waste_cost_cents, 15000);
});

test('summary: totals, rate, food already used by orders is not counted twice', () => {
  const report = parseWastageReport({
    from: '2026-10-01',
    to: '2026-10-28',
    costs_visible: true,
    items: [
      item(),
      item({ inventory_item_id: 'rice', name: 'Rice', usage_value_cents: '20000', waste_cost_cents: '0', waste_qty: 0, waste_after_use_qty: '300', waste_after_use_cost_cents: '900', closing_qty: 3000, opening_qty: 5000, receipts_qty: 0, usage_qty: 2000 }),
    ],
    daily: [{ day: '2026-10-02', events: 2, cost_cents: 15900 }],
    by_item_reason: [
      { inventory_item_id: 'chicken', reason: 'expiry', qty: 1000, cost_cents: 10000 },
      { inventory_item_id: 'chicken', reason: 'cooking_error', qty: 500, cost_cents: 5000 },
      { inventory_item_id: 'rice', reason: 'cooking_error', qty: 300, cost_cents: 900 },
    ],
  });
  const s = summarizeWastage(report);
  assert.equal(s.total_waste_cost_cents, 15900);
  // consumed = usage + stock-moving waste: (70000 + 15000) + (20000 + 0); rice's 900 is already inside its usage.
  assert.equal(s.consumed_value_cents, 105000);
  assert.equal(s.waste_rate_pct, 15.1);
  assert.equal(s.ingredients[0].name, 'Chicken');
  assert.equal(s.ingredients[0].top_reason, 'expiry');
  assert.equal(s.ingredients[1].waste_qty, 300);
  assert.equal(s.ingredients[1].waste_after_use_qty, 300);
  assert.equal(s.by_reason[0].reason, 'expiry');
  assert.equal(s.by_reason.find((r) => r.reason === 'cooking_error')?.cost_cents, 5900);
  assert.equal(s.entries, 2);
});

test('summary without cost permission returns no money figures', () => {
  const s = summarizeWastage({ from: 'a', to: 'b', branch_id: null, costs_visible: false, items: [item({ usage_value_cents: null, waste_cost_cents: null, unit_cost_cents: null })], daily: [], by_item_reason: [] });
  assert.equal(s.total_waste_cost_cents, null);
  assert.equal(s.waste_rate_pct, null);
  assert.equal(s.ingredients[0].waste_cost_cents, null);
  assert.equal(s.ingredients[0].waste_qty, 1500);
});

test('reversed waste nets out (report rows are net of reversals)', () => {
  // A 1000 g waste and its reversal net to 0 in the ledger sums the report returns.
  const s = summarizeWastage({ from: 'a', to: 'b', branch_id: null, costs_visible: true, items: [item({ waste_qty: 0, waste_cost_cents: 0, closing_qty: 8000 })], daily: [], by_item_reason: [] });
  assert.equal(s.total_waste_cost_cents, 0);
  assert.equal(s.ingredients.length, 0); // nothing wasted, nothing unexplained
});

test('trend buckets by day, ISO week and month, zero-filled', () => {
  assert.equal(weekStart('2026-10-28'), '2026-10-26'); // Wednesday → Monday
  assert.equal(weekStart('2026-10-26'), '2026-10-26');
  const daily = [
    { day: '2026-10-26', events: 1, cost_cents: 100 },
    { day: '2026-10-28', events: 2, cost_cents: 250 },
    { day: '2026-11-02', events: 1, cost_cents: 50 },
  ];
  const days = wasteTrend(daily, '2026-10-26', '2026-11-02', 'day');
  assert.equal(days.length, 8);
  assert.equal(days[1].cost_cents, 0);
  const weeks = wasteTrend(daily, '2026-10-26', '2026-11-02', 'week');
  assert.deepEqual(weeks.map((w) => [w.bucket, w.cost_cents]), [['2026-10-26', 350], ['2026-11-02', 50]]);
  const months = wasteTrend(daily, '2026-10-26', '2026-11-02', 'month');
  assert.deepEqual(months.map((m) => [m.bucket, m.cost_cents, m.events]), [['2026-10', 350, 3], ['2026-11', 50, 1]]);
});

test('alerts: rising waste, high rate, unexplained loss, over-purchasing', () => {
  const base = { from: 'a', to: 'b', branch_id: null, costs_visible: true, daily: [] };
  const cur = summarizeWastage({ ...base, items: [item({ closing_qty: 6300, stock_take_qty: -200 })], by_item_reason: [{ inventory_item_id: 'chicken', reason: 'expiry', qty: 1500, cost_cents: 15000 }] });
  const prev = summarizeWastage({ ...base, items: [item({ waste_qty: 500, waste_cost_cents: 5000, closing_qty: 7500 })], by_item_reason: [] });
  const kinds = wasteAlerts(cur, prev).map((a) => a.kind).sort();
  assert.deepEqual(kinds, ['high_waste_rate', 'over_purchasing', 'rising_waste', 'unexplained_loss']);
  const rising = wasteAlerts(cur, prev).find((a) => a.kind === 'rising_waste')!;
  assert.equal(rising.previous_cents, 5000);
  assert.equal(rising.severity, 'danger'); // tripled
  // No previous period → no "rising" claim.
  assert.equal(wasteAlerts(cur, null).some((a) => a.kind === 'rising_waste'), false);
  // Small changes are ignored.
  const tiny = summarizeWastage({ ...base, items: [item({ waste_cost_cents: 5200, usage_value_cents: 900000 })], by_item_reason: [] });
  assert.equal(wasteAlerts(tiny, prev).length, 0);
});

test('expiry estimate: first in, first out over receipts', () => {
  const now = new Date('2026-10-28T12:00:00Z');
  const receipts = [
    { received_at: '2026-10-27T09:00:00Z', qty: 2000 }, // expires 10-30 (shelf life 3)
    { received_at: '2026-10-24T09:00:00Z', qty: 3000 }, // expired 10-27
  ];
  // 4000 in stock = the newest 2000 + 2000 of the older delivery.
  const e = estimateExpiry(4000, receipts, 3, now, 3);
  assert.equal(e.status, 'expired');
  assert.equal(e.expired_qty, 2000);
  assert.equal(e.expiring_qty, 2000);
  assert.equal(e.days_left, 2);
  // Only the fresh delivery left.
  assert.equal(estimateExpiry(1500, receipts, 3, now, 1).status, 'ok');
  assert.equal(estimateExpiry(1500, receipts, 3, now, 3).status, 'soon');
  // More stock than every receipt seen: the rest is older than all of them.
  assert.equal(estimateExpiry(9000, receipts, 30, now).expired_qty, 4000);
  assert.equal(estimateExpiry(0, receipts, 3, now).status, 'no_stock');
  assert.equal(estimateExpiry(100, [], 3, now).status, 'unknown');
});

test('expiry list: only ingredients with a shelf life, most urgent first', () => {
  const now = new Date('2026-10-28T12:00:00Z');
  const list = expiryRisks(
    [
      { id: 'a', name: 'Milk', unit: 'ml', stock_qty: 1000, shelf_life_days: 5 },
      { id: 'b', name: 'Lettuce', unit: 'g', stock_qty: '500', shelf_life_days: 2 },
      { id: 'c', name: 'Rice', unit: 'g', stock_qty: 9000, shelf_life_days: null },
      { id: 'd', name: 'Cream', unit: 'ml', stock_qty: 200, shelf_life_days: 4 },
    ],
    [
      { inventory_item_id: 'a', created_at: '2026-10-27T08:00:00Z', delta_qty: 1000 },
      { inventory_item_id: 'b', created_at: '2026-10-25T08:00:00Z', delta_qty: '800' },
    ],
    now,
  );
  assert.deepEqual(list.map((r) => [r.name, r.status]), [['Lettuce', 'expired'], ['Cream', 'unknown'], ['Milk', 'ok']]);
});

test('error messages are plain language; missing migration is detected', () => {
  assert.match(wasteErrorMessage('insufficient_stock: 1234'), /not that much in stock/);
  assert.match(wasteErrorMessage('waste_entry_already_approved'), /already approved/);
  assert.match(wasteErrorMessage('waste_entry_not_reversible'), /only once/);
  assert.match(wasteErrorMessage('forbidden'), /permission/);
  assert.equal(isWastageSchemaMissing('PGRST202 Could not find the function public.wastage_report'), true);
  assert.equal(isWastageSchemaMissing('insufficient_stock'), false);
});
