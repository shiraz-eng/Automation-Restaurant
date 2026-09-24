import { notFound, redirect } from 'next/navigation';
import QRCode from 'qrcode';
import { createTenantServerClient } from '@/lib/supabase/tenant-server';
import { Card } from '@/components/ui';
import { StatCard } from '@/components/StatCard';
import { formatCents } from '@/lib/format';
import type { ReceiptConfig as PortalReceiptConfig } from '@/lib/receiptTemplate';
import { KdsBoard } from '../../(portal)/kds/KdsBoard';
import type { Kot, RecipeComponentRow } from '../../(portal)/kds/kitchenTypes';
import { AttendancePortalBoard, type RosterRow } from './AttendancePortalBoard';
import { AnalyticsSection } from './AnalyticsSection';
import { CheckoutClient, type Bill, type NewOrderCategory, type NewOrderItem } from '../../(portal)/checkout/CheckoutClient';
import { OrdersClient, type Order as OrdersClientOrder } from '../../(portal)/orders/OrdersClient';
import { ExpensesManager, type Expense, type ExpenseSupplier } from '../../(portal)/expenses/ExpensesManager';
import { SuppliersManager, type Supplier } from '../../(portal)/suppliers/SuppliersManager';
import { AiChat } from '../../(portal)/ai/AiChat';
import { InventoryManager } from '../../(portal)/inventory/InventoryManager';
import { RecipesManager, type Recipe, type MenuItemOption, type InventoryItemOption, type SubRecipeOption, type CategoryOption } from '../../(portal)/recipes/RecipesManager';
import { PurchasingClient, type PurchaseOrder, type Invoice, type Hold, type PayableRow } from '../../(portal)/purchasing/PurchasingClient';
import { DealsManager, type Deal, type MenuOption } from '../../(portal)/deals/DealsManager';
import { SocialManager } from '../../(portal)/social/SocialManager';
import { StaffManager } from '@/components/StaffManager';
import { SchedulingClient, type Shift, type Attendance } from '../../(portal)/scheduling/SchedulingClient';
import { DayCloseClient, type Closing } from '../../(portal)/close/DayCloseClient';
import { SectionReportButtons } from '@/components/SectionReportButtons';
import { MenuManager } from '../../(portal)/menu/MenuManager';
import type {
  Category as MenuCategory,
  Item as MenuItem,
  Ingredient as MenuIngredient,
  DealRow as MenuDealRow,
  RecipeRow as MenuRecipeRow,
  ProductAvailabilityRow,
} from '../../(portal)/menu/menuTypes';
import { PromotionsManager, type Promo, type PromoPerformance } from '../../(portal)/promotions/PromotionsManager';
import { TablesManager, type TableRow } from '../../(portal)/tables/TablesManager';
import { ExportHistoryPanel } from '../../(portal)/exports/ExportHistoryPanel';
import { resolvePortalCapabilities, portalSections, effectiveHas } from '@/lib/portalCapabilities';
import { FoodStockPanel } from '../../(portal)/kds/FoodStockPanel';
import { VariantsPanel } from '../../(portal)/menu/VariantsPanel';
import { AvailabilityHistory, type AvailabilityHistoryRow } from '../../(portal)/menu/availability/AvailabilityHistory';
import {
  PriorityManager,
  type PriorityRow,
  type MenuItemOption as PriorityMenuItemOption,
  type AvailabilityRow as PriorityAvailabilityRow,
} from '../../(portal)/menu/priority/PriorityManager';
import { IngredientCostPanel } from '../../(portal)/inventory/IngredientCostPanel';
import { PaymentReconciliationPanel, CashCountPanel } from '../../(portal)/close/ReconciliationPanels';
import { AttendanceInsights } from '../../(portal)/scheduling/AttendanceInsights';
import { ReviewsManager } from '../../(portal)/reviews/ReviewsManager';
import { ExceptionsPanel } from '../../(portal)/exceptions/ExceptionsPanel';
import { ApprovalsPanel } from '../../(portal)/approvals/ApprovalsPanel';
import { BrandKitSection } from '../../(portal)/settings/theme/BrandKitSection';
import { PoliciesManager } from '../../(portal)/settings/policies/PoliciesManager';
import {
  PortalsManager,
  type Portal as ManagedPortal,
  type PermRow,
} from '../../(portal)/portals/PortalsManager';

export const dynamic = 'force-dynamic';

const SITE = process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3005';

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

/** Monday 00:00 of the week containing `d`, in the server's local zone — same rule as the standalone Scheduling page. */
function weekStart(d = new Date()): Date {
  const s = new Date(d);
  s.setHours(0, 0, 0, 0);
  s.setDate(s.getDate() - ((s.getDay() + 6) % 7));
  return s;
}

export default async function PortalHome({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string; portalKey: string }>;
  searchParams: Promise<{ w?: string }>;
}) {
  const { slug, portalKey } = await params;
  const { w } = await searchParams;
  const t = await createTenantServerClient(slug);
  if (!t) notFound();

  const { data: portal } = await t.client
    .from('portals')
    .select('id, name, type, route_key, status, permissions')
    .eq('route_key', portalKey)
    .maybeSingle();
  if (!portal) notFound();
  if (portal.type === 'super_admin') redirect(`/r/${slug}`);

  const perms: string[] = portal.permissions ?? [];
  // Same dependency-aware check the Create Portal preview uses
  // (PERMISSION_REQUIRES), so an action only renders when it can work.
  const has = effectiveHas(perms);
  const hasAny = (keys: string[]) => keys.some(has);

  // ── Generated portal — a composition of the SAME real module
  // implementations every standalone Operations Portal page already uses,
  // one section per existing RMS area this portal actually holds a
  // permission for. `portal.type` is a Quick-start convenience label only
  // (it preselects starting permissions in Portal Management) and carries
  // NO authorization weight here — a section's inclusion is driven
  // entirely by has()/hasAny() reads of portal.permissions itself, never
  // by the portal's name or type. A portal named/typed "Attendance" that
  // was later granted Finance permissions gets the Finance section, full
  // stop; Portal Management has no predefined "Kitchen portal"/"Finance
  // portal" bundle concept, and neither does this page. Registering a
  // future module only means one more conditional section here — nothing
  // about this branching, the route, or the auth model needs to change.
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const monthStart = new Date(todayStart.getFullYear(), todayStart.getMonth(), 1);

  const caps = resolvePortalCapabilities(perms);
  const {
    operations: includeOperations,
    kitchen: includeKitchen,
    cashier: includeCashier,
    recipes: includeRecipes,
    inventory: includeInventory,
    suppliers: includeSuppliers,
    purchasing: includePurchasing,
    finance: canFinance,
    dayClose: includeDayClose,
    analytics: includeAnalytics,
    deals: includeDeals,
    social: includeSocial,
    staff: includeStaff,
    scheduling: includeScheduling,
    attendanceKiosk: includeAttendanceKiosk,
    ai: includeAi,
    menu: includeMenu,
    tables: includeTables,
    reportHistory: includeReportHistory,
    kitchenStock: includeKitchenStock,
    ingredientCosts: includeIngredientCosts,
    paymentReconcile: includePaymentReconcile,
    cashCount: includeCashCount,
    attendanceInsights: includeAttendanceInsights,
    aiApprovals: includeAiApprovals,
    variants: includeVariants,
    availability: includeAvailability,
    reviews: includeReviews,
    notifications: includeNotifications,
    settings: includeSettings,
    portals: includePortals,
  } = caps;

  const canCreateOrderCashier = has('orders.create');
  const canAttendanceMark = has('attendance.mark');
  const canAttendanceCheckIn = has('attendance.check_in');
  const canManageAutomation = has('finance.manage_purchases');
  const weekOffset = Number.parseInt(w ?? '0', 10) || 0;
  const weekStartDate = weekStart();
  weekStartDate.setDate(weekStartDate.getDate() + weekOffset * 7);
  const weekEndDate = new Date(weekStartDate);
  weekEndDate.setDate(weekEndDate.getDate() + 7);

  const [
    ordersRes,
    kdsOrdersRes,
    kdsCompletedTodayRes,
    kdsRecipeComponentsRes,
    kdsEntitlementsRes,
    cashierRes,
    settingsRes,
    cashierMenuCatRes,
    cashierMenuItemsRes,
    cashierAvailabilityRes,
    recipesRes,
    recipesMenuRes,
    recipesInventoryRes,
    recipesSubRes,
    recipesCategoriesRes,
    stockRes,
    stockLedgerRes,
    invSuppliersRes,
    supplierItemsRes,
    purchasingSettingsRes,
    suppliersRes,
    purchSuppliersRes,
    purchItemsRes,
    purchOrdersRes,
    purchInvoicesRes,
    purchHoldsRes,
    purchPayableRes,
    profitRes,
    expensesRes,
    closingsRes,
    dealsRes,
    dealsMenuRes,
    staffRes,
    membersRes,
    shiftsRes,
    attendanceRes,
    attendanceRosterRes,
  ] = await Promise.all([
    includeOperations
      ? t.client
          .from('orders')
          .select(
            'id, order_number, status, channel, table_label, customer_name, subtotal_cents, tax_cents, total_cents, created_at, order_lines(name_snapshot, qty, line_total_cents, kds_status)',
          )
          .order('created_at', { ascending: false })
          .limit(50)
      : Promise.resolve({ data: null }),
    includeKitchen
      ? t.client
          .from('orders')
          .select(
            'id, order_number, table_label, customer_name, channel, created_at, status, customer_note, ' +
              'order_lines(id, name_snapshot, variant_name_snapshot, qty, kds_status, modifiers, customer_note, menu_item_id, menu_items(station))',
          )
          .in('status', ACTIVE)
          .order('created_at', { ascending: true })
      : Promise.resolve({ data: null }),
    includeKitchen
      ? t.client
          .from('orders')
          .select('id', { count: 'exact', head: true })
          .in('status', ['served', 'paid'])
          .gte('created_at', todayStart.toISOString())
      : Promise.resolve({ count: 0 }),
    includeKitchen
      ? t.client
          .from('recipe_components')
          .select('inventory_item_id, qty_per_unit, variant_id, menu_item_id, inventory_items(name, unit)')
          .is('variant_id', null)
      : Promise.resolve({ data: null }),
    includeKitchen
      ? t.client.from('business_settings').select('plan_tier, plan_features').eq('id', true).maybeSingle()
      : Promise.resolve({ data: null }),
    includeCashier
      ? t.client
          .from('orders')
          .select(
            'id, order_number, session_id, table_label, customer_name, channel, status, subtotal_cents, discount_cents, tax_cents, tax_rate_bps, total_cents, refunded_cents, created_at, paid_at, order_lines(id, name_snapshot, variant_name_snapshot, qty, unit_price_cents, line_total_cents, modifiers, customer_note), payments(id, amount_cents, method, reference, tendered_cents, change_cents, status, refunded_cents, created_at)',
          )
          .in('status', UNPAID)
          .order('created_at', { ascending: true })
      : Promise.resolve({ data: null }),
    includeCashier
      ? t.client
          .from('business_settings')
          .select('brand_logo_url, brand_primary, receipt_footer_text, receipt_template_html, receipt_config, address, phone, contact_email, website, tax_registration_number, max_refund_without_approval_cents')
          .eq('id', true)
          .maybeSingle()
      : Promise.resolve({ data: null }),
    includeCashier && canCreateOrderCashier
      ? t.client.from('menu_categories').select('id, name').order('sort_order')
      : Promise.resolve({ data: null }),
    includeCashier && canCreateOrderCashier
      ? t.client
          .from('menu_items')
          .select('id, name, category_id, menu_variants(id, name, price_cents, sort_order, is_available)')
          .eq('is_available', true)
          .order('name')
      : Promise.resolve({ data: null }),
    includeCashier && canCreateOrderCashier
      ? t.client.from('product_availability').select('menu_item_id, variant_id, status')
      : Promise.resolve({ data: null }),
    includeRecipes
      ? t.client
          .from('recipes')
          .select(
            'id, name, description, notes, recipe_type, status, instructions, current_version_id, created_at, ' +
              'menu_item_id, variant_id, ' +
              'menu_items(name, menu_variants(name, price_cents, sort_order)), menu_variants(name, price_cents), ' +
              'recipe_versions!recipe_versions_recipe_id_fkey(id, version, status, yield_qty, yield_unit, effective_from, effective_to, ' +
              'recipe_ingredients(id, qty_base, sort_order, inventory_item_id, sub_recipe_id, inventory_items(name, unit, cost_cents_per_base_unit), recipes!recipe_ingredients_sub_recipe_id_fkey(name)), ' +
              'recipe_cost_log(cost_cents, recorded_at))',
          )
          .order('created_at', { ascending: false })
      : Promise.resolve({ data: null }),
    includeRecipes
      ? t.client.from('menu_items').select('id, name, price_cents, menu_variants(id, name, price_cents)').order('name')
      : Promise.resolve({ data: null }),
    includeRecipes
      ? t.client
          .from('inventory_items')
          .select(has('inventory.view_cost') ? 'id, name, unit, cost_cents_per_base_unit' : 'id, name, unit')
          .order('name')
      : Promise.resolve({ data: null }),
    includeRecipes
      ? t.client
          .from('recipes')
          .select('id, name, current_version_id, recipe_versions!recipes_current_version_fk(yield_qty, yield_unit)')
          .in('recipe_type', ['semi_finished', 'preparation'])
          .eq('status', 'active')
      : Promise.resolve({ data: null }),
    includeRecipes
      ? t.client.from('menu_categories').select('id, name').order('sort_order')
      : Promise.resolve({ data: null }),
    includeInventory
      ? t.client
          .from('inventory_items')
          .select(
            'id, name, unit, stock_qty, min_threshold, target_stock_qty, auto_reorder_email, supplier_name, cost_cents_per_base_unit',
          )
          .order('name')
      : Promise.resolve({ data: null }),
    includeInventory && has('stock.history')
      ? t.client
          .from('stock_ledger')
          .select('id, delta_qty, reason, created_at, inventory_items(name)')
          .order('created_at', { ascending: false })
          .limit(15)
      : Promise.resolve({ data: null }),
    includeInventory && canManageAutomation
      ? t.client.from('suppliers').select('id, name, email').eq('is_active', true).order('name')
      : Promise.resolve({ data: [] }),
    includeInventory && canManageAutomation
      ? t.client.from('supplier_items').select('id, supplier_id, inventory_item_id, is_preferred').eq('is_preferred', true)
      : Promise.resolve({ data: [] }),
    includeInventory && canManageAutomation
      ? t.client.from('purchasing_settings').select('low_stock_email_enabled').maybeSingle()
      : Promise.resolve({ data: null }),
    includeSuppliers
      ? t.client
          .from('suppliers')
          .select('id, name, contact_name, email, phone, address, payment_terms, notes, created_at, currency, credit_period_days, preferred_payment_method, is_active')
          .order('name')
      : Promise.resolve({ data: null }),
    includePurchasing
      ? t.client.from('suppliers').select('id, name').eq('is_active', true).order('name')
      : Promise.resolve({ data: null }),
    includePurchasing
      ? t.client.from('inventory_items').select('id, name, unit').order('name')
      : Promise.resolve({ data: null }),
    includePurchasing
      ? t.client
          .from('purchase_orders')
          .select(
            'id, po_number, status, expected_at, notes, created_at, received_at, approved_at, sent_at, supplier_id, subtotal_cents, suppliers(name), purchase_order_lines(id, description, qty, unit_cost_cents, received_qty, rejected_qty, reject_reason, inventory_item_id)',
          )
          .order('created_at', { ascending: false })
      : Promise.resolve({ data: null }),
    includePurchasing && hasAny(['invoices.create', 'invoices.match', 'invoices.view'])
      ? t.client
          .from('supplier_invoices')
          .select(
            'id, invoice_ref, supplier_invoice_number, invoice_date, due_date, total_cents, status, purchase_order_id, supplier_id, suppliers(name)',
          )
          .order('invoice_date', { ascending: false })
          .limit(30)
      : Promise.resolve({ data: [] }),
    includePurchasing && (has('payables.manage') || has('payables.view') || has('finance.view'))
      ? t.client
          .from('supplier_payment_holds')
          .select('id, reason, amount_cents, status, created_at, invoice_id, supplier_invoices(supplier_invoice_number, suppliers(name))')
          .eq('status', 'open')
          .order('created_at', { ascending: false })
      : Promise.resolve({ data: [] }),
    includePurchasing && (has('payables.view') || has('finance.view'))
      ? t.client.rpc('supplier_payable')
      : Promise.resolve({ data: [] }),
    canFinance
      ? t.client.rpc('period_profitability', { p_from: monthStart.toISOString(), p_to: new Date().toISOString() })
      : Promise.resolve({ data: null, error: null }),
    canFinance
      ? t.client.from('expenses').select('id, category, description, amount_cents, expense_date, supplier_id').order('expense_date', { ascending: false }).limit(200)
      : Promise.resolve({ data: null }),
    includeDayClose
      ? t.client
          .from('daily_closings')
          .select(
            'business_date, status, opening_cash_cents, closing_cash_cents, expected_cash_cents, difference_cents, gross_sales_cents, discounts_cents, refunds_cents, net_sales_cents, order_count, closed_at, reopened_at, note',
          )
          .order('business_date', { ascending: false })
          .limit(30)
      : Promise.resolve({ data: null }),
    includeDeals
      ? t.client
          .from('deals')
          .select(
            'id, name, description, image_url, price_cents, is_available, track_availability, available_qty, starts_at, ends_at, sort_order, deal_components(id, menu_item_id, variant_id, qty, sort_order), deal_option_groups(id, name, min_select, max_select, sort_order, deal_option_items(id, menu_item_id, variant_id, qty, price_adjustment_cents, is_default, sort_order))',
          )
          .order('sort_order')
      : Promise.resolve({ data: null }),
    includeDeals
      ? t.client.from('menu_items').select('id, name, menu_variants(id, name, price_cents)').order('name')
      : Promise.resolve({ data: null }),
    includeStaff
      ? t.client.from('memberships').select('id, email, full_name, role, status, created_at, shift_start_time').order('created_at', { ascending: true })
      : Promise.resolve({ data: null }),
    includeScheduling
      ? t.client.from('memberships').select('id, full_name, email, role').order('full_name')
      : Promise.resolve({ data: null }),
    includeScheduling
      ? t.client
          .from('shifts')
          .select('id, membership_id, starts_at, ends_at, role_label, notes')
          .gte('starts_at', weekStartDate.toISOString())
          .lt('starts_at', weekEndDate.toISOString())
          .order('starts_at')
      : Promise.resolve({ data: null }),
    includeScheduling
      ? t.client
          .from('attendance')
          .select('id, membership_id, clock_in, clock_out, note')
          .order('clock_in', { ascending: false })
          .limit(40)
      : Promise.resolve({ data: null }),
    includeAttendanceKiosk ? t.client.rpc('attendance_roster', {}) : Promise.resolve({ data: null }),
  ]);

  // Menu & Promotions / Tables — the same queries the
  // standalone /menu, /promotions and /tables pages run.
  const canViewMenuCost = has('inventory.view_cost');
  const [
    menuCategoriesRes,
    menuItemsRes,
    menuIngredientsRes,
    menuDealsRes,
    menuRecipesRes,
    menuAvailabilityRes,
    promosRes,
    promoPerfRes,
    promoMenuRes,
    tablesRes,
  ] = await Promise.all([
    includeMenu
      ? t.client.from('menu_categories').select('id, name, sort_order').order('sort_order')
      : Promise.resolve({ data: null }),
    includeMenu
      ? t.client
          .from('menu_items')
          .select(
            'id, name, description, price_cents, is_available, category_id, image_url, station, menu_variants(id, name, price_cents, sku, sort_order, is_available, track_availability, available_qty), modifier_groups(id, name, kind, min_select, max_select, sort_order, modifier_options(id, name, price_cents, is_available, sort_order)), recipe_components(id, inventory_item_id, qty_per_unit, variant_id, inventory_items(name, unit))',
          )
          .order('name')
      : Promise.resolve({ data: null }),
    includeMenu
      ? t.client.from('inventory_items').select('id, name, unit, stock_qty, min_threshold').order('name')
      : Promise.resolve({ data: null }),
    includeMenu
      ? t.client
          .from('deals')
          .select(
            'id, name, price_cents, is_available, deal_components(menu_item_id, variant_id, qty), deal_option_groups(deal_option_items(menu_item_id, variant_id))',
          )
          .eq('is_available', true)
          .order('sort_order')
      : Promise.resolve({ data: null }),
    includeMenu
      ? t.client
          .from('recipes')
          .select(
            `id, name, status, menu_item_id, variant_id, current_version_id, recipe_versions!recipe_versions_recipe_id_fkey(id, yield_qty, recipe_ingredients(${
              canViewMenuCost
                ? 'qty_base, inventory_item_id, sub_recipe_id, inventory_items(cost_cents_per_base_unit)'
                : 'qty_base, inventory_item_id, sub_recipe_id'
            }))`,
          )
          .eq('status', 'active')
      : Promise.resolve({ data: null }),
    includeMenu
      ? t.client
          .from('product_availability')
          .select('menu_item_id, variant_id, status, producible_qty, bottleneck_inventory_item_id, reason')
      : Promise.resolve({ data: null }),
    includeMenu
      ? t.client
          .from('promotions')
          .select(
            'id, name, kind, value_bps, value_cents, code, min_subtotal_cents, active, starts_at, ends_at, days_of_week, start_time, end_time, usage_limit_total, usage_count, auto_apply, bogo_menu_item_id, bogo_buy_qty, bogo_get_qty, bogo_get_discount_bps, created_at',
          )
          .order('created_at', { ascending: false })
      : Promise.resolve({ data: null }),
    includeMenu ? t.client.rpc('promotion_performance') : Promise.resolve({ data: null }),
    includeMenu ? t.client.from('menu_items').select('id, name').order('name') : Promise.resolve({ data: null }),
    includeTables
      ? t.client.from('restaurant_tables').select('id, label, seats, sort_order').order('sort_order')
      : Promise.resolve({ data: null }),
  ]);
  // Availability / Portal Management / Settings policies / own membership.
  const {
    data: { user: viewer },
  } = await t.client.auth.getUser();
  const [
    availabilityLogRes,
    priorityRes,
    priorityMenuRes,
    priorityAvailRes,
    managedPortalsRes,
    catalogRes,
    rolesRes,
    policiesRes,
    myMembershipRes,
  ] = await Promise.all([
    includeAvailability
      ? t.client
          .from('availability_audit_log')
          .select(
            'id, menu_item_id, variant_id, previous_status, new_status, previous_producible_qty, new_producible_qty, ' +
              'bottleneck_inventory_item_id, reason, trigger_type, trigger_reference, actor, created_at, ' +
              'menu_items(name), menu_variants(name), inventory_items(name)',
          )
          .order('created_at', { ascending: false })
          .limit(200)
      : Promise.resolve({ data: null }),
    includeAvailability
      ? t.client
          .from('product_priority')
          .select('id, menu_item_id, priority_level, priority_rank, updated_at, menu_items(name, category_id)')
          .order('priority_level')
          .order('priority_rank')
      : Promise.resolve({ data: null }),
    includeAvailability ? t.client.from('menu_items').select('id, name, category_id').order('name') : Promise.resolve({ data: null }),
    includeAvailability
      ? t.client.from('product_availability').select('menu_item_id, variant_id, status, producible_qty, reason')
      : Promise.resolve({ data: null }),
    includePortals
      ? t.client
          .from('portals')
          .select('id, name, type, route_key, status, permissions, email, last_login_at, last_logout_at, created_at')
          .order('created_at')
      : Promise.resolve({ data: null }),
    includePortals
      ? t.client.from('permission_catalog').select('key, grp, label, type, risk_level').order('grp')
      : Promise.resolve({ data: null }),
    includePortals ? t.client.from('roles').select('key, name, permissions').order('name') : Promise.resolve({ data: null }),
    includeSettings
      ? t.client.from('business_settings').select('max_refund_without_approval_cents').eq('id', true).maybeSingle()
      : Promise.resolve({ data: null }),
    includeAttendanceInsights && viewer
      ? t.client.from('memberships').select('id').eq('user_id', viewer.id).maybeSingle()
      : Promise.resolve({ data: null }),
  ]);
  const myMembershipId = (myMembershipRes.data as { id: string } | null)?.id ?? null;

  const tableRows: TableRow[] = await Promise.all(
    ((tablesRes.data ?? []) as { id: string; label: string; seats: number; sort_order: number }[]).map(async (r) => {
      const url = `${SITE}/order/${slug}?table=${encodeURIComponent(r.label)}`;
      const qrSvg = await QRCode.toString(url, {
        type: 'svg',
        margin: 1,
        width: 150,
        color: { dark: '#0f172a', light: '#ffffff' },
      });
      return { ...r, url, qrSvg };
    }),
  );

  const orders = (ordersRes.data ?? []) as unknown as OrdersClientOrder[];
  const todayOrders = orders.filter((o) => new Date(o.created_at) >= todayStart);
  const revenueToday = todayOrders.filter((o) => o.status === 'paid').reduce((s, o) => s + o.total_cents, 0);
  const profit = ((profitRes.data as ProfitRow[] | null) ?? [])[0] ?? null;
  const expenses = (expensesRes.data ?? []) as Expense[];
  const suppliers = (suppliersRes.data ?? []) as Supplier[];

  const invSuppliers = (invSuppliersRes.data ?? []) as { id: string; name: string; email: string | null }[];
  const preferredBySupplierItem = new Map(
    ((supplierItemsRes.data ?? []) as { id: string; supplier_id: string; inventory_item_id: string }[]).map((si) => [
      si.inventory_item_id,
      { supplierItemId: si.id, supplierId: si.supplier_id },
    ]),
  );
  const stockLedger = ((stockLedgerRes.data ?? []) as unknown as {
    id: string;
    delta_qty: number;
    reason: string;
    created_at: string;
    inventory_items: { name: string } | { name: string }[] | null;
  }[]).map((l) => ({
    id: l.id,
    delta_qty: l.delta_qty,
    reason: l.reason,
    created_at: l.created_at,
    item_name: Array.isArray(l.inventory_items) ? (l.inventory_items[0]?.name ?? '—') : (l.inventory_items?.name ?? '—'),
  }));

  const purchOrders = ((purchOrdersRes.data ?? []) as unknown as (Omit<PurchaseOrder, 'supplier_name'> & {
    suppliers: { name: string } | { name: string }[] | null;
  })[]).map((o) => ({
    ...o,
    supplier_name: Array.isArray(o.suppliers) ? (o.suppliers[0]?.name ?? null) : (o.suppliers?.name ?? null),
  })) as PurchaseOrder[];

  // Layer the recipe-driven engine's computed availability (and, once
  // configured, priority allocation) on top of the manual is_available
  // toggle the query above already filtered on — same rule Menu
  // Management/Customer Menu already use, so this portal's own Cashier
  // stops offering something the engine already knows is out of stock.
  const cashierAvailByItem = new Map<string, { variant_id: string | null; status: string }[]>();
  for (const r of (cashierAvailabilityRes.data ?? []) as { menu_item_id: string; variant_id: string | null; status: string }[]) {
    const arr = cashierAvailByItem.get(r.menu_item_id) ?? [];
    arr.push(r);
    cashierAvailByItem.set(r.menu_item_id, arr);
  }
  const cashierMenuItemsWithAvailability = ((cashierMenuItemsRes.data ?? []) as Record<string, unknown>[]).map((it) => ({
    ...it,
    menu_variants: ((it.menu_variants as Array<Record<string, unknown>>) ?? []).map((v) => ({
      ...v,
      computed_available: (cashierAvailByItem.get(it.id as string) ?? []).find((r) => r.variant_id === v.id)?.status !== 'unavailable',
    })),
  }));

  // Section nav: only the modules this portal actually holds a permission
  // for appear — an unselected module never renders a link, a section, or
  // (per the fetches above) even queries its data. Same list Portal
  // Management's live preview shows while an Owner is building this
  // portal — one function, not two copies of the rule.
  const sections = portalSections(caps);

  return (
    <div className="max-w-5xl space-y-6">
      <div>
        <h1 className="text-xl font-black">{portal.name}</h1>
        <p className="text-muted text-xs mt-1">Scoped to its granted permissions.</p>
      </div>

      {perms.length === 0 ? (
        <Card>
          <p className="text-muted text-xs">No portals granted yet — configure this in Portal Management.</p>
        </Card>
      ) : (
        <>
          {sections.length > 1 && (
            <div className="sticky top-0 z-10 -mx-1 flex flex-wrap gap-1.5 bg-main/95 backdrop-blur px-1 py-2 border-b border-border">
              {sections.map((s) => (
                <a
                  key={s.id}
                  href={`#${s.id}`}
                  className="rounded-full border border-border px-3 py-1 text-[11px] font-semibold hover:border-primary hover:text-primary"
                >
                  {s.label}
                </a>
              ))}
            </div>
          )}

          {includeNotifications && (
            <section id="notifications" className="scroll-mt-16">
              <h2 className="font-bold text-sm mb-3">Notifications</h2>
              <ExceptionsPanel slug={slug} canManage={hasAny(['notifications.manage', 'orders.view'])} showLinks={false} />
            </section>
          )}

          {includeOperations && (
            <section id="operations" className="scroll-mt-16">
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mb-3">
                <StatCard label="Orders today" value={todayOrders.length} hint={`${formatCents(revenueToday)} paid`} />
              </div>
              <div className="flex flex-wrap items-start justify-between gap-3 mb-3">
                <h2 className="font-bold text-sm">Operations</h2>
                <SectionReportButtons slug={slug} restaurantName={t.config.restaurantName} domain="orders" label="Orders" />
              </div>
              <OrdersClient orders={orders} canCancel={has('orders.cancel')} canUpdateStatus={has('orders.update')} canReopen={has('orders.reopen')} />
            </section>
          )}

          {(includeKitchen || includeKitchenStock) && (
            <section id="kitchen" className="scroll-mt-16 space-y-4">
              <h2 className="font-bold text-sm mb-3">Kitchen</h2>
              {includeKitchen && (
              <KdsBoard
                slug={slug}
                restaurantName={t.config.restaurantName}
                initial={(kdsOrdersRes.data ?? []) as unknown as Kot[]}
                completedToday={kdsCompletedTodayRes.count ?? 0}
                recipeComponents={(kdsRecipeComponentsRes.data ?? []) as unknown as RecipeComponentRow[]}
                canEdit={has('kitchen.update_status')}
                stationRoutingEntitled={
                  !kdsEntitlementsRes.data?.plan_tier ||
                  ((kdsEntitlementsRes.data?.plan_features as string[] | undefined) ?? []).includes('kds.station_routing')
                }
              />
              )}
              {includeKitchenStock && (
                <FoodStockPanel canManage={has('kitchen.manage_availability')} canWaste={has('kitchen.record_waste')} />
              )}
            </section>
          )}

          {includeCashier && (
            <section id="cashier" className="scroll-mt-16">
              <h2 className="font-bold text-sm mb-3">Cashier</h2>
              <CheckoutClient
                restaurantName={t.config.restaurantName}
                initial={(cashierRes.data ?? []) as Bill[]}
                canRefund={has('payments.refund')}
                canVoid={has('payments.void')}
                canDiscount={has('orders.apply_discount')}
                canCancel={has('orders.cancel')}
                canTakePayment={has('payments.accept')}
                receipt={{
                  logoUrl: settingsRes.data?.brand_logo_url ?? null,
                  primaryColor: settingsRes.data?.brand_primary ?? null,
                  footerText: settingsRes.data?.receipt_footer_text ?? null,
                  templateHtml: settingsRes.data?.receipt_template_html ?? null,
                  receiptConfig: (settingsRes.data?.receipt_config as PortalReceiptConfig | null) ?? null,
                  restaurant: {
                    address: settingsRes.data?.address ?? null,
                    phone: settingsRes.data?.phone ?? null,
                    email: settingsRes.data?.contact_email ?? null,
                    website: settingsRes.data?.website ?? null,
                    taxId: settingsRes.data?.tax_registration_number ?? null,
                  },
                }}
                canCreateOrder={canCreateOrderCashier}
                taxRateBps={800}
                menuCategories={(cashierMenuCatRes.data as NewOrderCategory[] | null) ?? []}
                menuItems={cashierMenuItemsWithAvailability as unknown as NewOrderItem[]}
                canViewReceipt={has('receipts.view')}
                canPrintReceipt={has('receipts.print')}
                canOverridePrice={has('orders.override_price')}
                canAdjustPayment={has('payments.adjust')}
                canApproveRefund={has('payments.approve_refund')}
                refundThresholdCents={((settingsRes.data as { max_refund_without_approval_cents?: number | null } | null)?.max_refund_without_approval_cents) ?? null}
              />
            </section>
          )}

          {includeTables && (
            <section id="tables" className="scroll-mt-16 space-y-6">
              <h2 className="font-bold text-sm mb-3">Tables &amp; QR codes</h2>
              <TablesManager rows={tableRows} canEdit={has('tables.update')} canCreate={hasAny(['tables.update', 'tables.create'])} />
            </section>
          )}

          {(includeMenu || includeVariants) && (
            <section id="menu" className="scroll-mt-16 space-y-6">
              <h2 className="font-bold text-sm mb-3">Menu &amp; Promotions</h2>
              {includeMenu && (
              <MenuManager
                slug={slug}
                categories={(menuCategoriesRes.data ?? []) as MenuCategory[]}
                items={(menuItemsRes.data ?? []) as unknown as MenuItem[]}
                ingredients={(menuIngredientsRes.data ?? []) as MenuIngredient[]}
                deals={(menuDealsRes.data ?? []) as unknown as MenuDealRow[]}
                recipes={(menuRecipesRes.data ?? []) as unknown as MenuRecipeRow[]}
                availabilityRows={(menuAvailabilityRes.data ?? []) as ProductAvailabilityRow[]}
                canEdit={has('menu.update')}
                canCreate={has('menu.create') && has('menu.update')}
                canDelete={has('menu.delete') && has('menu.update')}
                canViewCost={canViewMenuCost}
              />
              )}
              {includeVariants && (
                <div className="space-y-3">
                  <h3 className="font-bold text-xs text-muted uppercase tracking-wide">Variants</h3>
                  <VariantsPanel
                    canCreate={has('variants.create')}
                    canUpdate={has('variants.update')}
                    canArchive={has('variants.archive')}
                  />
                </div>
              )}
              {includeMenu && (
              <div className="space-y-3">
                <h3 className="font-bold text-xs text-muted uppercase tracking-wide">Promotions</h3>
                <PromotionsManager
                  promos={(promosRes.data ?? []) as Promo[]}
                  performance={(promoPerfRes.data ?? []) as PromoPerformance[]}
                  menuItems={(promoMenuRes.data ?? []) as { id: string; name: string }[]}
                  canEdit={has('menu.update')}
                />
              </div>
              )}
            </section>
          )}

          {includeAvailability && (
            <section id="availability" className="scroll-mt-16 space-y-6">
              <h2 className="font-bold text-sm mb-3">Availability</h2>
              <PriorityManager
                slug={slug}
                priorities={(priorityRes.data ?? []) as unknown as PriorityRow[]}
                menuItems={(priorityMenuRes.data ?? []) as PriorityMenuItemOption[]}
                availability={(priorityAvailRes.data ?? []) as PriorityAvailabilityRow[]}
                canManage={has('availability.update')}
              />
              <div className="space-y-3">
                <h3 className="font-bold text-xs text-muted uppercase tracking-wide">Availability history</h3>
                <AvailabilityHistory rows={(availabilityLogRes.data ?? []) as unknown as AvailabilityHistoryRow[]} />
              </div>
            </section>
          )}

          {(includeRecipes || includeIngredientCosts) && (
            <section id="recipes" className="scroll-mt-16 space-y-4">
              <h2 className="font-bold text-sm mb-3">Recipes &amp; Food Cost</h2>
              {includeRecipes && (
              <RecipesManager
                recipes={(recipesRes.data ?? []) as unknown as Recipe[]}
                menuItems={(recipesMenuRes.data ?? []) as unknown as MenuItemOption[]}
                inventoryItems={(recipesInventoryRes.data ?? []) as unknown as InventoryItemOption[]}
                subRecipes={(recipesSubRes.data ?? []) as unknown as SubRecipeOption[]}
                categories={(recipesCategoriesRes.data ?? []) as CategoryOption[]}
                canManage={has('inventory.manage_recipes') || has('finance.manage_recipes')}
                canViewCost={has('inventory.view_cost')}
              />
              )}
              {includeIngredientCosts && <IngredientCostPanel />}
            </section>
          )}

          {includeInventory && (
            <section id="inventory" className="scroll-mt-16 space-y-4">
              <div className="flex flex-wrap items-start justify-between gap-3 mb-3">
                <h2 className="font-bold text-sm">Inventory</h2>
                <SectionReportButtons slug={slug} restaurantName={t.config.restaurantName} domain="inventory" label="Inventory" />
              </div>
              <InventoryManager
                items={stockRes.data ?? []}
                canViewCost={has('inventory.view_cost')}
                canManageAutomation={canManageAutomation}
                canAddItem={has('stock.update')}
                canRestock={has('stock.adjust') || has('inventory.manage')}
                canWaste={has('inventory.manage_waste') || has('stock.adjust')}
                canCount={has('stock.count') || has('stock.adjust')}
                suppliers={invSuppliers}
                preferredBySupplierItem={Object.fromEntries(preferredBySupplierItem)}
                lowStockEmailEnabled={(purchasingSettingsRes.data as { low_stock_email_enabled?: boolean } | null)?.low_stock_email_enabled ?? false}
              />
              {has('stock.history') && (
              <Card>
                <h3 className="font-bold text-sm mb-3">Recent stock movements</h3>
                {stockLedger.length === 0 ? (
                  <p className="text-muted text-xs">Nothing yet.</p>
                ) : (
                  <table className="w-full text-left text-xs">
                    <tbody>
                      {stockLedger.map((l) => (
                        <tr key={l.id} className="border-b border-border/60 last:border-0">
                          <td className="py-2">{l.item_name}</td>
                          <td className="py-2 text-muted">{l.reason.replace('_', ' ')}</td>
                          <td className={`py-2 text-right font-mono ${Number(l.delta_qty) < 0 ? 'text-danger' : 'text-ok'}`}>
                            {Number(l.delta_qty) > 0 ? '+' : ''}
                            {l.delta_qty}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </Card>
              )}
            </section>
          )}

          {(includeSuppliers || includePurchasing) && (
            <section id="suppliers" className="scroll-mt-16 space-y-6">
              <h2 className="font-bold text-sm mb-3">Suppliers &amp; Purchasing</h2>
              {includeSuppliers && (
                <div className="space-y-3">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <h3 className="font-bold text-xs text-muted uppercase tracking-wide">Suppliers</h3>
                    <SectionReportButtons slug={slug} restaurantName={t.config.restaurantName} domain="suppliers" label="Suppliers" />
                  </div>
                  <SuppliersManager
                    suppliers={suppliers}
                    canManage={has('supplier.manage')}
                    canCreate={hasAny(['supplier.manage', 'supplier.create'])}
                    canEdit={hasAny(['supplier.manage', 'supplier.update'])}
                  />
                </div>
              )}
              {includePurchasing && (
                <div className="space-y-3">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <h3 className="font-bold text-xs text-muted uppercase tracking-wide">Purchasing</h3>
                    <SectionReportButtons slug={slug} restaurantName={t.config.restaurantName} domain="purchasing" label="Purchasing" />
                  </div>
                <PurchasingClient
                  suppliers={purchSuppliersRes.data ?? []}
                  items={purchItemsRes.data ?? []}
                  orders={purchOrders}
                  invoices={(purchInvoicesRes.data ?? []) as unknown as Invoice[]}
                  holds={(purchHoldsRes.data ?? []) as unknown as Hold[]}
                  payable={(purchPayableRes.data ?? []) as unknown as PayableRow[]}
                  canInvoice={has('invoices.create')}
                  canMatch={has('invoices.match')}
                  canPay={has('payables.record_payment')}
                  canManagePayables={has('payables.manage')}
                  canViewPayables={has('payables.view') || has('finance.view')}
                  canManagePO={has('purchases.update')}
                  canApprovePO={has('purchases.approve')}
                  canReceive={has('purchases.receive') || has('inventory.manage_purchases')}
                  canCreatePO={hasAny(['purchases.update', 'purchases.create'])}
                  canDeletePO={has('purchases.delete')}
                  canViewInvoices={hasAny(['invoices.create', 'invoices.match', 'invoices.view'])}
                />
                </div>
              )}
            </section>
          )}

          {(canFinance || includeDayClose || includePaymentReconcile || includeCashCount) && (
            <section id="finance" className="scroll-mt-16 space-y-6">
              <div className="flex flex-wrap items-start justify-between gap-3 mb-3">
                <h2 className="font-bold text-sm">Finance</h2>
                {canFinance && (
                  <SectionReportButtons slug={slug} restaurantName={t.config.restaurantName} domain="expenses" label="Expenses" />
                )}
              </div>
              {canFinance && (
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
              )}
              {includeDayClose && (
                <DayCloseClient
                  closings={(closingsRes.data ?? []) as Closing[]}
                  canClose={has('finance.close_day')}
                  canReopen={has('finance.reopen_day')}
                />
              )}
              {includeCashCount && <CashCountPanel />}
              {includePaymentReconcile && <PaymentReconciliationPanel />}
            </section>
          )}

          {includeAnalytics && (
            <section id="analytics" className="scroll-mt-16">
              <h2 className="font-bold text-sm mb-3">Analytics</h2>
              <AnalyticsSection slug={slug} restaurantName={t.config.restaurantName} />
            </section>
          )}

          {includeReportHistory && (
            <section id="reports" className="scroll-mt-16">
              <h2 className="font-bold text-sm mb-3">Report History</h2>
              <ExportHistoryPanel slug={slug} />
            </section>
          )}

          {includeReviews && (
            <section id="reviews" className="scroll-mt-16">
              <h2 className="font-bold text-sm mb-3">Reviews</h2>
              <ReviewsManager
                canAnalytics={has('reviews.analytics')}
                canRespond={has('reviews.respond')}
                canModerate={has('reviews.moderate')}
              />
            </section>
          )}

          {(includeDeals || includeSocial) && (
            <section id="marketing" className="scroll-mt-16 space-y-6">
              <h2 className="font-bold text-sm mb-3">Marketing &amp; Social</h2>
              {includeDeals && (
                <DealsManager
                  deals={(dealsRes.data ?? []) as Deal[]}
                  menu={(dealsMenuRes.data ?? []) as unknown as MenuOption[]}
                  canEdit={has('deals.update')}
                  canCreate={hasAny(['deals.update', 'deals.create'])}
                  canArchive={hasAny(['deals.update', 'deals.archive'])}
                />
              )}
              {includeSocial && (
                <SocialManager
                  slug={slug}
                  canManage={has('social.manage')}
                  canPropose={has('social.propose_post')}
                  canApprove={has('social.approve_post')}
                />
              )}
            </section>
          )}

          {(includeAttendanceKiosk || includeAttendanceInsights) && (
            <section id="attendance" className="scroll-mt-16 space-y-4">
              <h2 className="font-bold text-sm mb-3">Attendance</h2>
              {includeAttendanceKiosk && (
                <AttendancePortalBoard
                  initialRoster={(attendanceRosterRes.data ?? []) as RosterRow[]}
                  canMark={canAttendanceMark}
                  canCheckIn={canAttendanceCheckIn}
                  canCheckOut={has('attendance.check_out')}
                />
              )}
              {includeAttendanceInsights && (
                <AttendanceInsights
                  myMembershipId={myMembershipId}
                  caps={{
                    dashboard: has('attendance.view_dashboard'),
                    reports: has('attendance.view_reports'),
                    employeeReports: has('attendance.view_employee_reports'),
                    history: has('attendance.view_history'),
                    exportCsv: has('attendance.export'),
                    requestCorrection: has('attendance.request_correction'),
                    correct: has('attendance.correct'),
                    approveCorrection: has('attendance.approve_correction'),
                    viewOwn: has('attendance.view_own'),
                  }}
                />
              )}
            </section>
          )}

          {(includeStaff || includeScheduling) && (
            <section id="staff" className="scroll-mt-16 space-y-6">
              <h2 className="font-bold text-sm mb-3">Staff</h2>
              {includeStaff && (
                <StaffManager
                  staff={staffRes.data ?? []}
                  canAdd={has('staff.create')}
                  canChangeRole={has('permissions.assign')}
                  canEditShift={has('staff.update')}
                  canRemove={has('staff.delete')}
                />
              )}
              {includeScheduling && (
                <SchedulingClient
                  slug={slug}
                  weekOffset={weekOffset}
                  weekStartISO={weekStartDate.toISOString()}
                  members={membersRes.data ?? []}
                  shifts={(shiftsRes.data ?? []) as Shift[]}
                  attendance={(attendanceRes.data ?? []) as Attendance[]}
                  canManage={has('attendance.mark')}
                />
              )}
            </section>
          )}

          {includePortals && (
            <section id="portals" className="scroll-mt-16">
              <h2 className="font-bold text-sm mb-3">Portal Management</h2>
              <PortalsManager
                slug={slug}
                restaurantName={t.config.restaurantName}
                logoUrl={null}
                portals={(managedPortalsRes.data ?? []) as ManagedPortal[]}
                perms={((catalogRes.data ?? []) as PermRow[])}
                caps={{
                  create: has('portals.create'),
                  update: has('portals.update'),
                  disable: has('portals.disable'),
                  credentials: has('portals.credentials'),
                }}
                callerPermissions={perms}
                selfPortalId={portal.id}
                roles={(rolesRes.data ?? []) as { key: string; name: string; permissions: string[] }[]}
              />
            </section>
          )}

          {includeSettings && (
            <section id="settings" className="scroll-mt-16 space-y-6">
              <h2 className="font-bold text-sm mb-3">Settings</h2>
              <PoliciesManager
                slug={slug}
                maxRefundWithoutApprovalCents={
                  (policiesRes.data as { max_refund_without_approval_cents?: number | null } | null)
                    ?.max_refund_without_approval_cents ?? null
                }
                canEdit={has('settings.update')}
              />
              <BrandKitSection client={t.client} slug={slug} restaurantName={t.config.restaurantName} canEdit={has('settings.update')} />
            </section>
          )}

          {(includeAi || includeAiApprovals) && (
            <section id="ai" className="scroll-mt-16 space-y-4">
              <h2 className="font-bold text-sm mb-3">Assistant</h2>
              {includeAi &&
                (has('ai.execute_read') ? (
                  <AiChat slug={slug} />
                ) : (
                  <Card>
                    <p className="text-muted text-xs">
                      The assistant needs &ldquo;AI read actions&rdquo; as well to answer questions for this portal.
                    </p>
                  </Card>
                ))}
              {includeAiApprovals && (
                <div className="space-y-3">
                  <h3 className="font-bold text-xs text-muted uppercase tracking-wide">Waiting for approval</h3>
                  <ApprovalsPanel slug={slug} />
                </div>
              )}
            </section>
          )}
        </>
      )}
    </div>
  );
}
