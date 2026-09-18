import { notFound, redirect } from 'next/navigation';
import { createTenantServerClient } from '@/lib/supabase/tenant-server';
import { Card } from '@/components/ui';
import { StatCard } from '@/components/StatCard';
import { formatCents } from '@/lib/format';
import {
  KitchenPortalBoard,
  type KOrder,
  type KVariant,
  type Counter,
} from './KitchenPortalBoard';
import { AttendancePortalBoard, type RosterRow } from './AttendancePortalBoard';
import { CheckoutClient, type Bill, type NewOrderCategory, type NewOrderItem } from '../../(portal)/checkout/CheckoutClient';
import { OrdersClient, type Order as OrdersClientOrder } from '../../(portal)/orders/OrdersClient';
import { ExpensesManager, type Expense, type ExpenseSupplier } from '../../(portal)/expenses/ExpensesManager';
import { SuppliersManager, type Supplier } from '../../(portal)/suppliers/SuppliersManager';
import { AiChat } from '../../(portal)/ai/AiChat';

export const dynamic = 'force-dynamic';

const BLURB: Record<string, string> = {
  manager: 'Operational oversight scoped to its granted portals.',
  custom: 'A custom portal, scoped to its granted portals.',
};

type ProfitRow = {
  orders_count: number;
  gross_sales_cents: number;
  discount_cents: number;
  refunded_cents: number;
  net_sales_cents: number;
  theoretical_cogs_cents: number;
  gross_profit_cents: number;
  gross_margin_pct: number | null;
  expenses_cents: number;
  net_profit_cents: number;
  net_profit_margin_pct: number | null;
};

const ACTIVE = ['pending', 'in_kitchen', 'ready'];
const UNPAID = ['pending', 'in_kitchen', 'ready', 'served'];

export default async function PortalHome({
  params,
}: {
  params: Promise<{ slug: string; portalKey: string }>;
}) {
  const { slug, portalKey } = await params;
  const t = await createTenantServerClient(slug);
  if (!t) notFound();

  const { data: portal } = await t.client
    .from('portals')
    .select('name, type, route_key, status, permissions')
    .eq('route_key', portalKey)
    .maybeSingle();
  if (!portal) notFound();
  if (portal.type === 'super_admin') redirect(`/r/${slug}`);

  const perms: string[] = portal.permissions ?? [];
  const has = (k: string) => perms.includes('*') || perms.includes(k);
  const hasAny = (keys: string[]) => keys.some(has);

  if (portal.type === 'kitchen') {
    const [{ data: orders }, { data: variants }, { data: counters }] = await Promise.all([
      t.client
        .from('orders')
        .select(
          'id, order_number, table_label, channel, status, customer_note, created_at, pickup_counter_portal_id, order_lines(id, name_snapshot, qty, kds_status, modifiers, customer_note)',
        )
        .in('status', ACTIVE)
        .order('created_at', { ascending: true }),
      t.client
        .from('menu_variants')
        .select('id, name, is_available, track_availability, available_qty, menu_items(name)')
        .order('name'),
      t.client.from('portals').select('id, name').eq('type', 'checkout').eq('status', 'active').order('name'),
    ]);
    return (
      <div className="space-y-4">
        <h1 className="text-xl font-black">{portal.name}</h1>
        <KitchenPortalBoard
          initialOrders={(orders ?? []) as KOrder[]}
          initialVariants={(variants ?? []) as unknown as KVariant[]}
          counters={(counters ?? []) as Counter[]}
          canAvailability={has('kitchen.manage_availability') || has('availability.update')}
          canWaste={has('kitchen.record_waste')}
        />
      </div>
    );
  }

  if (portal.type === 'attendance') {
    const { data: roster } = await t.client.rpc('attendance_roster', {});
    return (
      <div className="space-y-4">
        <h1 className="text-xl font-black">{portal.name}</h1>
        <AttendancePortalBoard
          initialRoster={(roster ?? []) as RosterRow[]}
          canMark={has('attendance.mark')}
          canCheckIn={has('attendance.check_in')}
        />
      </div>
    );
  }

  if (portal.type === 'checkout') {
    const canCreateOrder = has('orders.create');
    const [{ data: bills }, { data: settings }, { data: menuCategories }, { data: menuItems }] = await Promise.all([
      t.client
        .from('orders')
        .select(
          'id, order_number, session_id, table_label, customer_name, status, subtotal_cents, discount_cents, tax_cents, total_cents, refunded_cents, created_at, order_lines(id, name_snapshot, qty, unit_price_cents, line_total_cents), payments(id, amount_cents, method, status, refunded_cents, created_at)',
        )
        .in('status', UNPAID)
        .order('created_at', { ascending: true }),
      t.client.from('business_settings').select('receipt_logo_url, receipt_footer_text, receipt_template_html').eq('id', true).maybeSingle(),
      canCreateOrder
        ? t.client.from('menu_categories').select('id, name').order('sort_order')
        : Promise.resolve({ data: null }),
      canCreateOrder
        ? t.client
            .from('menu_items')
            .select('id, name, category_id, menu_variants(id, name, price_cents, sort_order, is_available)')
            .eq('is_available', true)
            .order('name')
        : Promise.resolve({ data: null }),
    ]);
    return (
      <div className="space-y-4">
        <h1 className="text-xl font-black">{portal.name}</h1>
        <CheckoutClient
          restaurantName={t.config.restaurantName}
          initial={(bills ?? []) as Bill[]}
          canRefund={has('payments.refund')}
          canVoid={has('payments.void')}
          canDiscount={has('orders.apply_discount')}
          canCancel={has('orders.cancel')}
          receipt={{
            logoUrl: settings?.receipt_logo_url ?? null,
            footerText: settings?.receipt_footer_text ?? null,
            templateHtml: settings?.receipt_template_html ?? null,
          }}
          canCreateOrder={canCreateOrder}
          taxRateBps={800}
          menuCategories={(menuCategories as NewOrderCategory[] | null) ?? []}
          menuItems={(menuItems as unknown as NewOrderItem[] | null) ?? []}
        />
      </div>
    );
  }

  // General board (manager/custom types) — a real, live operational
  // summary instead of a bare permission list, built from the SAME
  // queries/RPCs the Dashboard and other portals already use, each
  // fetched only when this portal's own granted permissions cover it.
  // t.client is the portal account's own RLS-scoped client (not
  // service-role), so period_profitability's own has_perm() check is a
  // second, real backstop here — not just this page's has() gate.
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const monthStart = new Date(todayStart.getFullYear(), todayStart.getMonth(), 1);

  // orders.view (the Operations bundle's core permission) gets the SAME
  // OrdersClient the regular Operations Portal's own Orders page uses —
  // real order management, not just a read-only count — reused exactly
  // like checkout/kitchen/attendance types already reuse their own
  // dedicated client components. Today's stat is derived from this same
  // fetch rather than a second query.
  // Finance (Expenses/profit) and Suppliers & Purchasing (Suppliers) get
  // the SAME real, editable manager components their own pages in the
  // Operations Portal use — not a read-only figure. finance.view alone
  // doesn't imply expense-record access, so this checks every relevant
  // key in the Finance bundle; period_profitability itself still
  // requires finance.view_profit/finance.view_cogs/inventory.view_cost
  // (checked against this portal's own RLS-scoped client, a real second
  // backstop) and simply returns nothing if none is held.
  const canFinance = hasAny(['finance.view', 'finance.create_expense', 'finance.update_expense', 'finance.delete_expense', 'finance.view_profit']);
  const canSuppliers = has('supplier.view');

  const [ordersRes, kitchenRes, stockRes, profitRes, expensesRes, suppliersRes] = await Promise.all([
    has('orders.view')
      ? t.client
          .from('orders')
          .select(
            'id, order_number, status, channel, table_label, customer_name, subtotal_cents, tax_cents, total_cents, created_at, order_lines(name_snapshot, qty, line_total_cents, kds_status)',
          )
          .order('created_at', { ascending: false })
          .limit(50)
      : Promise.resolve({ data: null }),
    has('kitchen.view')
      ? t.client.from('orders').select('id', { count: 'exact', head: true }).in('status', ACTIVE)
      : Promise.resolve({ data: null, count: null }),
    has('stock.view')
      ? t.client.from('inventory_items').select('name, stock_qty, min_threshold, unit').order('name')
      : Promise.resolve({ data: null }),
    canFinance
      ? t.client.rpc('period_profitability', { p_from: monthStart.toISOString(), p_to: new Date().toISOString() })
      : Promise.resolve({ data: null, error: null }),
    canFinance
      ? t.client.from('expenses').select('id, category, description, amount_cents, expense_date, supplier_id').order('expense_date', { ascending: false }).limit(200)
      : Promise.resolve({ data: null }),
    canSuppliers
      ? t.client
          .from('suppliers')
          .select('id, name, contact_name, email, phone, address, payment_terms, notes, created_at, currency, credit_period_days, preferred_payment_method, is_active')
          .order('name')
      : Promise.resolve({ data: null }),
  ]);

  const orders = (ordersRes.data ?? []) as unknown as OrdersClientOrder[];
  const todayOrders = orders.filter((o) => new Date(o.created_at) >= todayStart);
  const revenueToday = todayOrders.filter((o) => o.status === 'paid').reduce((s, o) => s + o.total_cents, 0);
  const lowStock = ((stockRes.data ?? []) as { name: string; stock_qty: number; min_threshold: number; unit: string }[]).filter(
    (i) => Number(i.stock_qty) <= Number(i.min_threshold),
  );
  const profit = ((profitRes.data as ProfitRow[] | null) ?? [])[0] ?? null;
  const expenses = (expensesRes.data ?? []) as Expense[];
  const suppliers = (suppliersRes.data ?? []) as Supplier[];

  return (
    <div className="max-w-5xl space-y-6">
      <div>
        <h1 className="text-xl font-black">{portal.name}</h1>
        <p className="text-muted text-xs mt-1">{BLURB[portal.type] ?? BLURB.custom}</p>
      </div>

      {perms.length === 0 ? (
        <Card>
          <p className="text-muted text-xs">No portals granted yet — configure this in Portal Management.</p>
        </Card>
      ) : (
        <>
          {(has('orders.view') || has('kitchen.view') || has('stock.view')) && (
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
              {has('orders.view') && (
                <StatCard label="Orders today" value={todayOrders.length} hint={`${formatCents(revenueToday)} paid`} />
              )}
              {has('kitchen.view') && <StatCard label="Active kitchen tickets" value={kitchenRes.count ?? 0} />}
              {has('stock.view') && (
                <StatCard label="Low stock" value={lowStock.length} tone={lowStock.length > 0 ? 'warn' : 'default'} />
              )}
            </div>
          )}

          {has('stock.view') && lowStock.length > 0 && (
            <Card>
              <h2 className="font-bold text-sm mb-3">Low stock</h2>
              <ul className="text-xs space-y-1">
                {lowStock.slice(0, 8).map((i) => (
                  <li key={i.name} className="flex justify-between">
                    <span>{i.name}</span>
                    <span className="text-warn font-mono">
                      {i.stock_qty}{i.unit} / min {i.min_threshold}{i.unit}
                    </span>
                  </li>
                ))}
              </ul>
            </Card>
          )}

          {has('orders.view') && (
            <div>
              <h2 className="font-bold text-sm mb-3">Orders</h2>
              <OrdersClient orders={orders} canCancel={has('orders.cancel')} />
            </div>
          )}

          {canSuppliers && (
            <div>
              <h2 className="font-bold text-sm mb-3">Suppliers</h2>
              <SuppliersManager suppliers={suppliers} />
            </div>
          )}

          {canFinance && (
            <div>
              <h2 className="font-bold text-sm mb-3">Finance</h2>
              <ExpensesManager
                expenses={expenses}
                profit={profit}
                periodFromIso={monthStart.toISOString()}
                periodToIso={new Date().toISOString()}
                periodLabel="this month"
                canWrite={hasAny(['finance.create_expense', 'finance.update_expense'])}
                canDelete={has('finance.delete_expense')}
                canViewProfit={has('finance.view_profit')}
                suppliers={suppliers as unknown as ExpenseSupplier[]}
              />
            </div>
          )}

          {has('ai.view') && (
            <div>
              <h2 className="font-bold text-sm mb-3">Assistant</h2>
              <AiChat slug={slug} />
            </div>
          )}
        </>
      )}
    </div>
  );
}
