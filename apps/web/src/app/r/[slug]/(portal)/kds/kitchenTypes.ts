/**
 * Kitchen Operations data model + pure helpers. KOT = one `orders` row +
 * its `order_lines` — there is no separate kot/kitchen_tickets table.
 * `orders.status` (whole-ticket) and `order_lines.kds_status` (per-item
 * prep) are the two authoritative fields every lane/action reads from and
 * writes to, exactly as the existing kitchen_* RPCs (schema.sql) already
 * model them — this file adds no new state machine, only a shared,
 * consistent way to derive a lane/urgency/label from that existing state.
 */

export type LineStatus = 'queued' | 'preparing' | 'ready' | 'served';
export type OrderStatus = 'pending' | 'in_kitchen' | 'ready' | 'served' | 'paid' | 'void';

export type ModSnapshot = { id: string; name: string; price_cents: number };
export type KotLine = {
  id: string;
  name_snapshot: string;
  variant_name_snapshot: string | null;
  qty: number;
  kds_status: LineStatus;
  modifiers: ModSnapshot[] | null;
  customer_note: string | null;
  menu_item_id: string | null;
  menu_items: { station: string | null } | { station: string | null }[] | null;
};
export type Kot = {
  id: string;
  order_number: number;
  table_label: string | null;
  customer_name: string | null;
  channel: string;
  created_at: string;
  status: OrderStatus;
  customer_note: string | null;
  order_lines: KotLine[];
};

function one<T>(x: T | T[] | null): T | null {
  return Array.isArray(x) ? (x[0] ?? null) : x;
}

/** Every station this KOT's lines touch — a ticket can span stations
 *  (spec §8: "One KOT may contain items associated with different
 *  stations"); null/blank station groups under "Unassigned". */
export function stationsForKot(kot: Kot): string[] {
  const set = new Set<string>();
  for (const l of kot.order_lines) {
    const station = one(l.menu_items)?.station?.trim();
    set.add(station || 'Unassigned');
  }
  return [...set];
}

/** Same 20-minute threshold apps/api/src/lib/aiTools.ts already uses for
 *  get_kitchen_performance()'s delayed-order count and the Attention page's
 *  MEDIUM-severity kitchen exceptions — reused here instead of a fourth,
 *  independently-invented number (the pre-redesign KdsBoard/KitchenBoard/
 *  KitchenPortalBoard each hardcoded their own different threshold). */
export const DELAY_MINUTES = 20;

export type Lane = 'new' | 'preparing' | 'ready' | 'delayed' | 'completed';
export const LANE_LABEL: Record<Lane, string> = {
  new: 'New',
  preparing: 'Preparing',
  ready: 'Ready',
  delayed: 'Delayed',
  completed: 'Completed',
};

export function ageMinutes(iso: string): number {
  return (Date.now() - new Date(iso).getTime()) / 60000;
}

export function formatElapsed(minutes: number): string {
  const m = Math.max(0, Math.floor(minutes));
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return h > 0 ? `${h}:${String(mm).padStart(2, '0')}:00` : `${mm}:00`;
}

/** One lane per KOT — Delayed takes priority over New/Preparing/Ready once
 *  a still-active ticket crosses DELAY_MINUTES, matching the reference's
 *  mutually-exclusive tab counts (New/Preparing/Ready/Delayed sum to the
 *  active total; Completed is separate). */
export function laneOf(kot: Kot): Lane {
  if (kot.status === 'served' || kot.status === 'paid') return 'completed';
  if (ageMinutes(kot.created_at) >= DELAY_MINUTES) return 'delayed';
  const lines = kot.order_lines;
  if (lines.length > 0 && lines.every((l) => l.kds_status === 'ready' || l.kds_status === 'served')) return 'ready';
  if (lines.some((l) => l.kds_status === 'preparing' || l.kds_status === 'ready')) return 'preparing';
  return 'new';
}

/** The one primary action available for a KOT's current lane — mirrors
 *  exactly what kitchen_start_order/kitchen_mark_ready/kitchen_complete_order
 *  do; a delayed ticket keeps whatever action its underlying prep state
 *  would otherwise offer (delayed is a visibility flag, not a 6th state). */
export function primaryAction(kot: Kot): { label: string; rpc: 'kitchen_start_order' | 'kitchen_mark_ready' | 'kitchen_complete_order' } | null {
  const allReady = kot.order_lines.length > 0 && kot.order_lines.every((l) => l.kds_status === 'ready' || l.kds_status === 'served');
  if (allReady) return { label: 'Complete Order', rpc: 'kitchen_complete_order' };
  // orders.status is never meaningfully 'pending' once a ticket is visible
  // — place_order() finalizes every order at 'in_kitchen' as its own last
  // step, so "has anything actually been started" can only be read from
  // order_lines.kds_status, not orders.status.
  const started = kot.order_lines.some((l) => l.kds_status !== 'queued');
  if (started) return { label: 'Mark Ready', rpc: 'kitchen_mark_ready' };
  return { label: 'Start Preparing', rpc: 'kitchen_start_order' };
}

export function orderTypeLabel(channel: string): string {
  return channel.replace('_', ' ');
}

/** table_label is free text (order/page.tsx just stores whatever the guest
 *  typed) — some older orders already stored the full "Table 1" string,
 *  newer ones just the bare number. Strips a redundant leading "Table "
 *  so a "TABLE " prefix in the UI never doubles up either way. */
export function tableNumberLabel(tableLabel: string | null): string | null {
  if (!tableLabel) return null;
  return tableLabel.replace(/^table\s+/i, '');
}

/** Base (non-variant-specific) recipe_components rows — what place_order()
 *  itself reads for consumption, reused read-only here for the inspector's
 *  "ingredients this order consumes" panel (same simplification the Menu
 *  editor's own recipe summary already makes: variant_id is null only). */
export type RecipeComponentRow = {
  inventory_item_id: string;
  qty_per_unit: number;
  variant_id: string | null;
  menu_item_id: string;
  inventory_items: { name: string; unit: string } | { name: string; unit: string }[] | null;
};
