// Shared shapes and pure helpers for the Deals & Combos workspace. The
// status/validity/price maths here only DISPLAYS what the database stores —
// selling rules are enforced server-side (tenant-migrations/0064).

export type DealComponent = {
  id?: string;
  menu_item_id: string | null;
  variant_id: string | null;
  qty: number;
  sort_order: number;
};
export type DealOptionItem = {
  id?: string;
  menu_item_id: string | null;
  variant_id: string | null;
  qty: number;
  price_adjustment_cents: number;
  is_default: boolean;
  sort_order: number;
};
export type DealOptionGroup = {
  id?: string;
  name: string;
  min_select: number;
  max_select: number | null;
  sort_order: number;
  deal_option_items: DealOptionItem[];
};

export type DealType = 'combo' | 'meal_deal' | 'bucket' | 'discount';
export type DealLifecycle = 'draft' | 'active' | 'paused';
export type DealStatus = 'draft' | 'active' | 'paused' | 'scheduled' | 'expired';
export type OrderType = 'dine_in' | 'takeaway' | 'delivery';
export type SalesChannel = 'customer_portal' | 'pos';

export type DealRow = {
  id: string;
  ref_code: string | null;
  name: string;
  description: string | null;
  image_url: string | null;
  price_cents: number;
  deal_type: DealType;
  status: DealLifecycle;
  is_available: boolean;
  starts_at: string | null;
  ends_at: string | null;
  active_days: number[] | null;
  start_time: string | null;
  end_time: string | null;
  min_qty: number;
  max_qty: number | null;
  usage_limit: number | null;
  order_types: OrderType[];
  sales_channels: SalesChannel[];
  tagline: string | null;
  badge: string | null;
  show_savings: boolean;
  sort_order: number;
  created_at: string;
  deal_components: DealComponent[];
  deal_option_groups: DealOptionGroup[];
};

export type MenuPick = {
  id: string;
  name: string;
  price_cents: number;
  image_url: string | null;
  menu_variants: { id: string; name: string; price_cents: number }[];
};

export type DealPerf = { deal_id: string; orders: number; qty: number; revenue_cents: number };
export type DealAvail = { deal_id: string; available_qty: number | null; bottleneck_name: string | null };
export type DailyPoint = { day: string; orders: number; revenue_cents: number };

export const DEAL_SELECT =
  'id, ref_code, name, description, image_url, price_cents, deal_type, status, is_available, starts_at, ends_at, ' +
  'active_days, start_time, end_time, min_qty, max_qty, usage_limit, order_types, sales_channels, tagline, badge, ' +
  'show_savings, sort_order, created_at, deal_components(id, menu_item_id, variant_id, qty, sort_order), ' +
  'deal_option_groups(id, name, min_select, max_select, sort_order, deal_option_items(id, menu_item_id, variant_id, qty, price_adjustment_cents, is_default, sort_order))';

export const MENU_PICK_SELECT = 'id, name, price_cents, image_url, menu_variants(id, name, price_cents)';

export const TYPE_LABEL: Record<DealType, string> = {
  combo: 'Combo',
  meal_deal: 'Meal Deal',
  bucket: 'Bucket',
  discount: 'Discount',
};
export const STATUS_LABEL: Record<DealStatus, string> = {
  draft: 'Draft',
  active: 'Active',
  paused: 'Paused',
  scheduled: 'Scheduled',
  expired: 'Expired',
};
export const STATUS_STYLE: Record<DealStatus, string> = {
  draft: 'bg-warn/10 text-warn border-warn/30',
  active: 'bg-ok/10 text-ok border-ok/30',
  paused: 'bg-main text-muted border-border',
  scheduled: 'bg-primary/10 text-primary border-primary/30',
  expired: 'bg-danger/10 text-danger border-danger/30',
};
export const ORDER_TYPE_LABEL: Record<OrderType, string> = { dine_in: 'Dine-in', takeaway: 'Takeaway', delivery: 'Delivery' };
export const CHANNEL_LABEL: Record<SalesChannel, string> = { customer_portal: 'Customer Portal', pos: 'POS' };
export const DAY_LABEL = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** Draft/paused come from the stored lifecycle; scheduled/expired from dates. */
export function dealStatus(d: Pick<DealRow, 'status' | 'starts_at' | 'ends_at'>, now = new Date()): DealStatus {
  if (d.status === 'draft') return 'draft';
  if (d.ends_at && new Date(d.ends_at) < now) return 'expired';
  if (d.status === 'paused') return 'paused';
  if (d.starts_at && new Date(d.starts_at) > now) return 'scheduled';
  return 'active';
}

export function itemPrice(menu: Map<string, MenuPick>, itemId: string | null, variantId: string | null): number {
  if (!itemId) return 0;
  const m = menu.get(itemId);
  if (!m) return 0;
  if (variantId) return m.menu_variants.find((v) => v.id === variantId)?.price_cents ?? m.price_cents;
  return m.price_cents;
}

export function itemLabel(menu: Map<string, MenuPick>, itemId: string | null, variantId: string | null): string {
  if (!itemId) return 'Item';
  const m = menu.get(itemId);
  if (!m) return 'Item';
  const v = variantId ? m.menu_variants.find((x) => x.id === variantId) : null;
  return v ? `${m.name} · ${v.name}` : m.name;
}

/** À la carte value of the fixed components (option groups count their defaults). */
export function regularValue(
  menu: Map<string, MenuPick>,
  components: DealComponent[],
  groups: DealOptionGroup[] = [],
): number {
  const fixed = components.reduce((s, c) => s + itemPrice(menu, c.menu_item_id, c.variant_id) * c.qty, 0);
  const defaults = groups.reduce((s, g) => {
    const d = g.deal_option_items.filter((i) => i.is_default);
    return s + d.reduce((x, i) => x + itemPrice(menu, i.menu_item_id, i.variant_id) * i.qty, 0);
  }, 0);
  return fixed + defaults;
}

export function discountPct(regular: number, price: number): number | null {
  if (regular <= 0 || price >= regular) return null;
  return Math.round(((regular - price) / regular) * 100);
}

function shortDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/** "Sep 20 – Oct 15", "Every Fri–Sun", "Always". */
export function validityLabel(d: Pick<DealRow, 'starts_at' | 'ends_at' | 'active_days'>): string {
  const days = d.active_days && d.active_days.length > 0 && d.active_days.length < 7 ? d.active_days : null;
  const dayText = days ? daysLabel(days) : null;
  if (d.starts_at || d.ends_at) {
    const range = `${d.starts_at ? shortDate(d.starts_at) : 'Now'} – ${d.ends_at ? shortDate(d.ends_at) : 'Ongoing'}`;
    return dayText ? `${range} · ${dayText}` : range;
  }
  return dayText ? `Every ${dayText}` : 'Always';
}

export function daysLabel(days: number[]): string {
  const sorted = [...days].sort((a, b) => a - b);
  if (sorted.length === 7) return 'All days';
  // contiguous run → "Fri–Sun" style (Sunday wraps after Saturday)
  const order = [1, 2, 3, 4, 5, 6, 0];
  const idx = sorted.map((d) => order.indexOf(d)).sort((a, b) => a - b);
  const contiguous = idx.every((v, i) => i === 0 || v === idx[i - 1] + 1);
  if (contiguous && idx.length > 2) return `${DAY_LABEL[order[idx[0]]]}–${DAY_LABEL[order[idx[idx.length - 1]]]}`;
  return idx.map((i) => DAY_LABEL[order[i]]).join(', ');
}

export function timeLabel(t: string | null): string {
  if (!t) return '';
  const [h, m] = t.split(':').map(Number);
  const d = new Date();
  d.setHours(h, m, 0, 0);
  return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

export function money(cents: number, currency: string): string {
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency,
      maximumFractionDigits: cents % 100 === 0 ? 0 : 2,
    }).format(cents / 100);
  } catch {
    return (cents / 100).toFixed(2);
  }
}
