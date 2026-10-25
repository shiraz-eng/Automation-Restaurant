import type { ReactNode } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  Activity, Ban, Banknote, CalendarClock, CircleCheck, ClipboardList, Coins, CreditCard, Flame, Megaphone, Package, PackageX,
  Percent, ReceiptText, ScrollText, Send, Share2, ShoppingBag, Star, Tag, Trash2, TrendingUp, Truck, Undo2, UserCheck, Users, UtensilsCrossed, type LucideIcon,
} from 'lucide-react';
import { formatCents } from '@/lib/format';
import { addDays, rangeLabel, resolveFinancePeriod, todayIn, zonedDayStart } from '@/lib/financePeriod';
import { fromStock } from '@/lib/inventoryStock';
import {
  ModuleKpiCard, ModuleKpiGrid, ModuleSkeleton, ModuleUnavailableKpi, percentChange, type ModuleAccent,
} from '@/components/module/ModuleLanding';
import type { ModuleKey } from '@/lib/modules';
import { dealStatus } from '../../deals/dealTypes';

/**
 * Each module landing's KPI cards. Every figure is read with the signed-in
 * user's own Supabase client (tenant RLS applies), using the same tables,
 * RPCs and definitions as the screen the card links to, and each card is
 * shown only to viewers holding that screen's permission. A query that fails
 * renders "Unavailable" with the reason — never a placeholder number.
 */
export type KpiCtx = {
  client: SupabaseClient;
  can: (key: string) => boolean;
  base: string;
  timeZone: string;
  /** Business settings / plan facts the Settings landing reports. */
  tier: string | null;
  subscriptionStatus: string | null;
  isOwner: boolean;
  isBranchWorkspace: boolean;
};

type Err = { message: string } | null;
const n = (v: unknown) => Number(v ?? 0);
const count = (c: number | null | undefined) => (c ?? 0).toLocaleString();

function Card(p: {
  icon: LucideIcon; accent: ModuleAccent; label: string; value: string; footnote?: string; href?: string;
  delta?: number | null; goodWhenUp?: boolean; compareLabel?: string; danger?: boolean; error?: Err;
}) {
  if (p.error) return <ModuleUnavailableKpi label={p.label} message={p.error.message} />;
  return (
    <ModuleKpiCard
      icon={p.icon}
      accent={p.accent}
      label={p.label}
      value={p.value}
      footnote={p.footnote}
      href={p.href}
      delta={p.delta}
      goodWhenUp={p.goodWhenUp}
      compareLabel={p.compareLabel}
      valueTone={p.danger ? 'danger' : undefined}
    />
  );
}

export function ModuleKpiSkeleton({ cards }: { cards: number }) {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4" aria-busy="true" aria-label="Loading figures">
      {Array.from({ length: cards }, (_, i) => (
        <ModuleSkeleton key={i} className="h-[5.75rem]" />
      ))}
    </div>
  );
}

/** How many KPI cards each landing shows at most (for its loading skeleton); 0 = none. */
export const KPI_CARDS: Record<ModuleKey, number> = {
  pos: 4, kitchen: 4, menu: 3, marketing: 4, inventory: 4, suppliers: 4, finance: 0, staff: 3, analytics: 4, ai: 0, settings: 4,
};

export async function ModuleKpis({ module, ctx }: { module: ModuleKey; ctx: KpiCtx }) {
  const cards = await LOADERS[module]?.(ctx);
  if (!cards || cards.length === 0) return null;
  return <ModuleKpiGrid>{cards}</ModuleKpiGrid>;
}

type Loader = (ctx: KpiCtx) => Promise<ReactNode[]>;

const UNPAID = ['pending', 'in_kitchen', 'ready', 'served'];
type DayRow = { business_date: string; net_sales_cents: number; orders_count: number };

const LOADERS: Partial<Record<ModuleKey, Loader>> = {
  // ── POS & Orders: today's sales as on the dashboard, and the open bills Checkout lists.
  async pos({ client, can, base, timeZone }) {
    const today = todayIn(timeZone);
    const yesterday = addDays(today, -1);
    const [daysRes, openRes] = await Promise.all([
      can('analytics.view') ? client.rpc('sales_by_day', { p_from: yesterday, p_to: today }) : null,
      can('orders.view') || can('payments.view')
        ? client.from('orders').select('total_cents', { count: 'exact' }).in('status', UNPAID).limit(1000)
        : null,
    ]);
    const out: ReactNode[] = [];
    if (daysRes) {
      const rows = (daysRes.data ?? []) as DayRow[];
      const t = rows.find((r) => r.business_date === today);
      const y = rows.find((r) => r.business_date === yesterday);
      const sales = n(t?.net_sales_cents);
      const orders = n(t?.orders_count);
      const ySales = n(y?.net_sales_cents);
      const yOrders = n(y?.orders_count);
      out.push(
        <Card key="sales" icon={TrendingUp} accent="emerald" label="Today's Sales" value={formatCents(sales)} error={daysRes.error}
          delta={percentChange(sales, ySales)} compareLabel="vs yesterday" footnote="Net sales" href={`${base}/orders`} />,
        <Card key="orders" icon={ShoppingBag} accent="blue" label="Orders Today" value={orders.toLocaleString()} error={daysRes.error}
          delta={percentChange(orders, yOrders)} compareLabel="vs yesterday" footnote="Served and paid" href={`${base}/orders`} />,
        <Card key="aov" icon={ReceiptText} accent="violet" label="Average Order" value={orders > 0 ? formatCents(Math.round(sales / orders)) : '—'} error={daysRes.error}
          delta={orders > 0 && yOrders > 0 ? percentChange(sales / orders, ySales / yOrders) : null} compareLabel="vs yesterday" footnote="Today's net sales ÷ orders" />,
      );
    }
    if (openRes) {
      const total = ((openRes.data ?? []) as { total_cents: number }[]).reduce((s, r) => s + n(r.total_cents), 0);
      out.push(
        <Card key="open" icon={CreditCard} accent="amber" label="Open Bills" value={count(openRes.count)} error={openRes.error}
          footnote={openRes.count ? `${formatCents(total)} waiting to be paid` : 'Nothing waiting to be paid'} href={can('payments.view') ? `${base}/checkout` : undefined} />,
      );
    }
    return out;
  },

  // ── Kitchen: the tickets the Kitchen Display shows, by stage, and dishes off sale.
  async kitchen({ client, can, base }) {
    if (!can('kitchen.view')) return [];
    const stage = (s: string) => client.from('orders').select('id', { count: 'exact', head: true }).eq('status', s);
    const [pending, cooking, ready, off] = await Promise.all([
      stage('pending'),
      stage('in_kitchen'),
      stage('ready'),
      client.from('product_availability').select('menu_item_id').eq('status', 'unavailable').limit(2000),
    ]);
    const offCount = new Set(((off.data ?? []) as { menu_item_id: string }[]).map((r) => r.menu_item_id)).size;
    const kds = `${base}/kds`;
    return [
      <Card key="new" icon={ClipboardList} accent="blue" label="New Tickets" value={count(pending.count)} error={pending.error} footnote="Waiting to be started" href={kds} />,
      <Card key="cooking" icon={Flame} accent="orange" label="Cooking" value={count(cooking.count)} error={cooking.error} footnote="In the kitchen now" href={kds} />,
      <Card key="ready" icon={CircleCheck} accent="emerald" label="Ready to Serve" value={count(ready.count)} error={ready.error} footnote="Waiting to go out" href={kds} />,
      <Card key="off" icon={Ban} accent="rose" label="Dishes Off Sale" value={offCount.toLocaleString()} error={off.error} danger={offCount > 0}
        footnote={offCount ? 'Not enough stock to cook them' : 'Everything can be cooked'} href={kds} />,
    ];
  },

  // ── Menu: dishes, what the stock engine has taken off sale, and live deals.
  async menu({ client, can, base }) {
    const [items, off, deals] = await Promise.all([
      can('menu.view') ? client.from('menu_items').select('is_available') : null,
      can('menu.view') ? client.from('product_availability').select('menu_item_id').eq('status', 'unavailable').limit(2000) : null,
      can('deals.view') ? client.from('deals').select('status, starts_at, ends_at') : null,
    ]);
    const out: ReactNode[] = [];
    if (items) {
      const rows = (items.data ?? []) as { is_available: boolean }[];
      const hidden = rows.filter((r) => !r.is_available).length;
      out.push(<Card key="items" icon={UtensilsCrossed} accent="fuchsia" label="Menu Items" value={rows.length.toLocaleString()} error={items.error}
        footnote={hidden ? `${hidden} switched off` : 'All switched on'} href={`${base}/menu`} />);
    }
    if (off) {
      const c = new Set(((off.data ?? []) as { menu_item_id: string }[]).map((r) => r.menu_item_id)).size;
      out.push(<Card key="off" icon={Ban} accent="rose" label="Off Sale Now" value={c.toLocaleString()} error={off.error} danger={c > 0}
        footnote={c ? 'Out of stock by recipe' : 'Every dish can be made'} href={`${base}/menu/availability`} />);
    }
    if (deals) {
      const rows = (deals.data ?? []) as { status: 'draft' | 'active' | 'paused'; starts_at: string | null; ends_at: string | null }[];
      const live = rows.filter((d) => dealStatus(d) === 'active').length;
      out.push(<Card key="deals" icon={Tag} accent="violet" label="Live Deals" value={live.toLocaleString()} error={deals.error}
        footnote={`${rows.length.toLocaleString()} ${rows.length === 1 ? 'deal' : 'deals'} in total`} href={`${base}/deals`} />);
    }
    return out;
  },

  // ── Marketing: live promotions, the social posts queue, and the guest rating Reviews shows.
  async marketing({ client, can, base }) {
    const nowIso = new Date().toISOString();
    const since30 = new Date(Date.now() - 30 * 86_400_000).toISOString();
    const [promos, drafts, published, rating] = await Promise.all([
      can('menu.view')
        ? client.from('promotions').select('starts_at').eq('active', true).or(`ends_at.is.null,ends_at.gt.${nowIso}`).limit(2000)
        : null,
      can('social.view') ? client.from('social_posts').select('id', { count: 'exact', head: true }).eq('status', 'draft') : null,
      can('social.view') ? client.from('social_posts').select('id', { count: 'exact', head: true }).eq('status', 'published').gte('published_at', since30) : null,
      can('reviews.view') ? client.from('feedback').select('overall').gte('created_at', since30).limit(5000) : null,
    ]);
    const out: ReactNode[] = [];
    if (promos) {
      out.push(<Card key="promos" icon={Megaphone} accent="amber" label="Active Promotions" value={((promos.data ?? []) as { starts_at: string | null }[]).filter((p) => !p.starts_at || p.starts_at <= nowIso).length.toLocaleString()} error={promos.error}
        footnote="Switched on and in date" href={`${base}/promotions`} />);
    }
    if (drafts) out.push(<Card key="drafts" icon={Share2} accent="blue" label="Posts to Approve" value={count(drafts.count)} error={drafts.error}
      footnote="Social drafts waiting for a decision" href={`${base}/social`} />);
    if (published) out.push(<Card key="published" icon={Send} accent="emerald" label="Posts Published" value={count(published.count)} error={published.error}
      footnote="Last 30 days" href={`${base}/social`} />);
    if (rating) {
      const rows = (rating.data ?? []) as { overall: number }[];
      const avg = rows.length ? Math.round((rows.reduce((s, r) => s + n(r.overall), 0) / rows.length) * 10) / 10 : null;
      out.push(<Card key="rating" icon={Star} accent="amber" label="Guest Rating" value={avg == null ? '—' : `${avg} / 5`} error={rating.error}
        footnote={rows.length ? `${rows.length} review(s), last 30 days` : 'No reviews in the last 30 days'} href={`${base}/reviews`} />);
    }
    return out;
  },

  // ── Inventory: stock levels as the dashboard counts them, and waste this month from the ledger.
  async inventory({ client, can, base, timeZone }) {
    const month = resolveFinancePeriod({ period: 'month' }, timeZone);
    const [stock, waste] = await Promise.all([
      can('stock.view') ? fromStock<{ stock_qty: number; min_threshold: number }[]>((tb) => client.from(tb).select('stock_qty, min_threshold')) : null,
      can('finance.view') ? client.rpc('ledger_summary', { p_from: month.from, p_to: month.to }) : null,
    ]);
    const out: ReactNode[] = [];
    if (stock) {
      const rows = stock.data ?? [];
      const low = rows.filter((i) => n(i.stock_qty) <= n(i.min_threshold)).length;
      const empty = rows.filter((i) => n(i.stock_qty) <= 0).length;
      const inv = `${base}/inventory`;
      out.push(
        <Card key="items" icon={Package} accent="emerald" label="Stock Items" value={rows.length.toLocaleString()} error={stock.error} footnote="Ingredients tracked" href={inv} />,
        <Card key="low" icon={PackageX} accent="amber" label="Low Stock" value={low.toLocaleString()} error={stock.error} danger={low > 0}
          footnote={low ? 'At or below the reorder level' : 'Everything above its reorder level'} href={inv} />,
        <Card key="out" icon={Ban} accent="rose" label="Out of Stock" value={empty.toLocaleString()} error={stock.error} danger={empty > 0} footnote="Nothing left" href={inv} />,
      );
    }
    if (waste) {
      const row = ((waste.data ?? []) as { category: string; net_cents: number }[]).find((r) => r.category === 'waste');
      out.push(<Card key="waste" icon={Trash2} accent="slate" label="Waste This Month" value={formatCents(n(row?.net_cents))} error={waste.error}
        footnote={`Spoilage at cost · ${rangeLabel(month.from, month.to)}`} href={`${base}/finance/ledger?category=waste&period=month`} />);
    }
    return out;
  },

  // ── Suppliers: the same counts Purchasing and the Finance overview use.
  async suppliers({ client, can, base }) {
    const canPayables = can('payables.view') || can('payables.manage') || can('finance.view');
    const [sup, pos, inv, pay] = await Promise.all([
      can('supplier.view') ? client.from('suppliers').select('id', { count: 'exact', head: true }).eq('is_active', true) : null,
      can('purchases.view') ? client.from('purchase_orders').select('id', { count: 'exact', head: true }).in('status', ['draft', 'sent', 'partial']) : null,
      can('purchases.view') ? client.from('supplier_invoices').select('id', { count: 'exact', head: true }).eq('status', 'received') : null,
      canPayables ? client.rpc('supplier_payable') : null,
    ]);
    const out: ReactNode[] = [];
    if (sup) out.push(<Card key="sup" icon={Truck} accent="blue" label="Active Suppliers" value={count(sup.count)} error={sup.error} footnote="Suppliers you buy from" href={`${base}/suppliers`} />);
    if (pos) out.push(<Card key="po" icon={ClipboardList} accent="indigo" label="Open Purchase Orders" value={count(pos.count)} error={pos.error} footnote="Draft, sent or part-received" href={`${base}/purchasing`} />);
    if (inv) out.push(<Card key="inv" icon={ReceiptText} accent="amber" label="Invoices to Match" value={count(inv.count)} error={inv.error} danger={(inv.count ?? 0) > 0}
      footnote="Waiting for the 3-way match" href={`${base}/purchasing`} />);
    if (pay) {
      const t = ((pay.data ?? []) as { outstanding_cents: number; overdue_cents: number }[]).reduce(
        (s, r) => ({ owed: s.owed + n(r.outstanding_cents), overdue: s.overdue + n(r.overdue_cents) }), { owed: 0, overdue: 0 });
      out.push(<Card key="pay" icon={Banknote} accent="rose" label="Owed to Suppliers" value={formatCents(t.owed)} error={pay.error} danger={t.overdue > 0}
        footnote={t.overdue ? `${formatCents(t.overdue)} overdue` : 'Nothing overdue'} href={`${base}/purchasing`} />);
    }
    return out;
  },

  // ── Staff: the team list and today's rota / attendance as Shifts shows them.
  async staff({ client, can, base, timeZone }) {
    const today = todayIn(timeZone);
    const dayStart = zonedDayStart(today, timeZone).toISOString();
    const dayEnd = zonedDayStart(addDays(today, 1), timeZone).toISOString();
    const since = new Date(Date.now() - 24 * 3_600_000).toISOString();
    const [team, shifts, onClock] = await Promise.all([
      can('staff.view') ? client.from('memberships').select('status') : null,
      can('attendance.view') ? client.from('shifts').select('id', { count: 'exact', head: true }).gte('starts_at', dayStart).lt('starts_at', dayEnd) : null,
      can('attendance.view') ? client.from('attendance').select('id', { count: 'exact', head: true }).is('clock_out', null).gte('clock_in', since) : null,
    ]);
    const out: ReactNode[] = [];
    if (team) {
      const rows = (team.data ?? []) as { status: string }[];
      const active = rows.filter((r) => r.status === 'active').length;
      const pending = rows.filter((r) => r.status === 'pending').length;
      out.push(<Card key="team" icon={Users} accent="teal" label="Team Members" value={active.toLocaleString()} error={team.error}
        footnote={pending ? `${pending} invite(s) not accepted yet` : 'Active accounts'} href={`${base}/staff`} />);
    }
    if (shifts) out.push(<Card key="shifts" icon={CalendarClock} accent="blue" label="Shifts Today" value={count(shifts.count)} error={shifts.error} footnote="On the rota today" href={`${base}/scheduling`} />);
    if (onClock) out.push(<Card key="clock" icon={UserCheck} accent="emerald" label="Clocked In Now" value={count(onClock.count)} error={onClock.error} footnote="Clocked in within the last 24 hours" href={`${base}/scheduling`} />);
    return out;
  },

  // ── Analytics: month-to-date sales vs the same days last month, audit activity, guest rating.
  async analytics({ client, can, base, timeZone }) {
    const m = resolveFinancePeriod({ period: 'month' }, timeZone);
    const since7 = new Date(Date.now() - 7 * 86_400_000).toISOString();
    const since30 = new Date(Date.now() - 30 * 86_400_000).toISOString();
    const [cur, prev, audit, rating] = await Promise.all([
      can('analytics.view') ? client.rpc('sales_by_day', { p_from: m.from, p_to: m.to }) : null,
      can('analytics.view') ? client.rpc('sales_by_day', { p_from: m.prevFrom, p_to: m.prevTo }) : null,
      can('reports.view') ? client.from('audit_logs').select('id', { count: 'exact', head: true }).gte('created_at', since7) : null,
      can('reviews.view') ? client.from('feedback').select('overall').gte('created_at', since30).limit(5000) : null,
    ]);
    const out: ReactNode[] = [];
    if (cur && prev) {
      const sum = (rows: unknown, k: keyof DayRow) => ((rows ?? []) as DayRow[]).reduce((s, r) => s + n(r[k]), 0);
      const sales = sum(cur.data, 'net_sales_cents');
      const orders = sum(cur.data, 'orders_count');
      const before = prev.error ? null : { sales: sum(prev.data, 'net_sales_cents'), orders: sum(prev.data, 'orders_count') };
      const vs = `vs ${rangeLabel(m.prevFrom, m.prevTo)}`;
      out.push(
        <Card key="sales" icon={TrendingUp} accent="emerald" label="Sales This Month" value={formatCents(sales)} error={cur.error}
          delta={percentChange(sales, before?.sales)} compareLabel={vs} footnote="Net sales" href={base} />,
        <Card key="orders" icon={ShoppingBag} accent="blue" label="Orders This Month" value={orders.toLocaleString()} error={cur.error}
          delta={percentChange(orders, before?.orders)} compareLabel={vs} footnote="Served and paid" href={base} />,
      );
    }
    if (audit) out.push(<Card key="audit" icon={ScrollText} accent="slate" label="Changes Logged" value={count(audit.count)} error={audit.error} footnote="In the audit log, last 7 days" href={`${base}/audit`} />);
    if (rating) {
      const rows = (rating.data ?? []) as { overall: number }[];
      const avg = rows.length ? Math.round((rows.reduce((s, r) => s + n(r.overall), 0) / rows.length) * 10) / 10 : null;
      out.push(<Card key="rating" icon={Star} accent="amber" label="Guest Rating" value={avg == null ? '—' : `${avg} / 5`} error={rating.error}
        footnote={rows.length ? `${rows.length} review(s), last 30 days` : 'No reviews in the last 30 days'} href={`${base}/reviews`} />);
    }
    return out;
  },

  // ── Settings: the money rules and plan currently in force.
  async settings({ client, can, base, tier, subscriptionStatus, isOwner, isBranchWorkspace }) {
    // Currency, Tax, Refund approvals and Billing are owner-only screens.
    if (!isOwner || !can('settings.view')) return [];
    const [cur, tax, refund] = await Promise.all([
      client.rpc('get_currency'),
      client.rpc('get_tax_settings'),
      client.from('business_settings').select('max_refund_without_approval_cents').eq('id', true).maybeSingle(),
    ]);
    const taxRow = (Array.isArray(tax.data) ? tax.data[0] : tax.data) as { tax_enabled: boolean; tax_rate_bps: number } | null;
    const limit = (refund.data as { max_refund_without_approval_cents: number | null } | null)?.max_refund_without_approval_cents ?? null;
    return [
      <Card key="cur" icon={Coins} accent="amber" label="Currency" value={typeof cur.data === 'string' ? cur.data : '—'} error={cur.error} footnote="On bills, reports and exports" href={`${base}/settings/currency`} />,
      <Card key="tax" icon={Percent} accent="teal" label="Sales Tax" value={taxRow ? (taxRow.tax_enabled ? `${taxRow.tax_rate_bps / 100}%` : 'Off') : '—'} error={tax.error}
        footnote="Charged on every new order" href={`${base}/settings/tax`} />,
      <Card key="refund" icon={Undo2} accent="orange" label="Refund Sign-off" value={limit == null ? 'No limit' : `Above ${formatCents(limit)}`} error={refund.error}
        footnote={limit == null ? 'Staff with refund rights need no approval' : 'Needs someone with refund approval'} href={`${base}/settings/refunds`} />,
      <Card key="plan" icon={Activity} accent="violet" label="Plan" value={tier ? tier.replace(/^\w/, (c) => c.toUpperCase()) : '—'}
        footnote={subscriptionStatus ? `Subscription ${subscriptionStatus}` : 'Subscription'} href={isBranchWorkspace ? undefined : `${base}/billing`} />,
    ];
  },
};

