import type { Metadata } from 'next';
import { Suspense } from 'react';
import { notFound } from 'next/navigation';
import {
  BookOpen, CalendarCheck, ChartColumn, CreditCard, HandCoins, Landmark, PieChart, ReceiptText, Settings, Undo2, Wallet, type LucideIcon,
} from 'lucide-react';
import type { FeatureKey } from '@automation-restaurant/shared';
import { createTenantServerClient } from '@/lib/supabase/tenant-server';
import { loadTenantCurrency } from '@/lib/currencyServer';
import { gatePortalPage, can } from '@/lib/permissions';
import { getTenantEntitlement } from '@/lib/entitlements';
import { PlanUpgradePaywall } from '@/components/PlanUpgradePaywall';
import { rangeLabel, resolveFinancePeriod } from '@/lib/financePeriod';
import { ModuleHeader, ModuleSection, ModuleSkeleton, ModuleToolGrid, type ModuleAccent, type ModuleTool } from '@/components/module/ModuleLanding';
import { ModuleRangePicker } from '@/components/module/ModuleRangePicker';
import { FinanceKpis, KpiSkeleton, RecentTransactions, RevenueExpenseSection, type Access } from './FinanceLandingSections';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Finance' };

/**
 * The Finance module's landing page: KPIs, the Finance tools (each an existing
 * screen), revenue vs expenses and recent money movements for the chosen
 * period. Every figure comes from the financial ledger (ledger_summary /
 * ledger_events, RLS: finance.view) read with the signed-in user's own
 * session — the same source and definitions as the Finance overview.
 */

export default async function FinancePage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ period?: string; from?: string; to?: string }>;
}) {
  const { slug } = await params;
  const sp = await searchParams;
  const t = await createTenantServerClient(slug);
  if (!t) notFound();
  await loadTenantCurrency(t.client);
  const { role, perms } = await gatePortalPage(t.client, slug, 'finance.view');
  const ent = await getTenantEntitlement(t.client, t.config.tier);
  if (!ent.isEntitled('accounting.finance')) {
    return <PlanUpgradePaywall slug={slug} featureKey="accounting.finance" currentTier={ent.tier} />;
  }

  // Same rules as the Finance overview.
  const access: Access = {
    canCogs: can(perms, role, 'finance.view_cogs') || can(perms, role, 'finance.view_profit') || can(perms, role, 'inventory.view_cost'),
    canPayables: can(perms, role, 'payables.view') || can(perms, role, 'payables.manage') || can(perms, role, 'finance.view'),
  };

  const { data: settings } = await t.client.from('business_settings').select('timezone').maybeSingle();
  const range = resolveFinancePeriod(sp, settings?.timezone ?? 'UTC');
  const base = `/r/${slug}`;
  const rangeQuery = `period=custom&from=${range.from}&to=${range.to}`;

  // Mirrors the sidebar's canSee() in the portal layout: permission, owner-only
  // and (for staff) plan gates. Each destination page enforces its own gate
  // again; hiding a tile is never the security boundary.
  const isBranchWorkspace = Boolean(t.config.parentSlug);
  const allowed = (key: string, ownerOnly = false, feature?: FeatureKey) => {
    if (ownerOnly && role !== 'owner') return false;
    if (!can(perms, role, key)) return false;
    if (role !== 'owner' && feature && !ent.isEntitled(feature)) return false;
    return true;
  };
  const tool = (key: string, title: string, description: string, path: string, icon: LucideIcon, accent: ModuleAccent): ModuleTool => ({
    key, title, description, href: `${base}/${path}`, icon, accent,
  });
  const tools = [
    tool('overview', 'Finance Overview', 'Profit, food cost, payables aging and month-by-month results.', `finance/overview?${rangeQuery}`, ChartColumn, 'violet'),
    tool('expenses', 'Expenses', 'Record, approve and pay operating expenses.', `expenses?${rangeQuery}`, ReceiptText, 'blue'),
    tool('ledger', 'Ledger', 'Every money event, traceable to the record behind it.', `finance/ledger?${rangeQuery}`, BookOpen, 'emerald'),
    allowed('settings.view', true) && tool('refunds', 'Refund Approvals', 'Set how large a refund staff can give before it needs sign-off.', 'settings/refunds', Undo2, 'orange'),
    allowed('purchases.view', false, 'inventory.recipe_deduction') &&
      tool('payouts', 'Payments & Payouts', 'Match supplier invoices, record payouts and see what you owe.', 'purchasing', HandCoins, 'indigo'),
    allowed('settings.view', true) && tool('tax', 'Tax & Compliance', 'The sales tax rate charged on every order.', 'settings/tax', Landmark, 'amber'),
    tool('close', 'Day Close & Cash', 'Cash movements, counted cash and locking the business day.', 'close', CalendarCheck, 'teal'),
    allowed('reports.view', false, 'analytics.advanced') && tool('reports', 'Reports', 'Every PDF report and Excel export, who ran it and for when.', 'exports', PieChart, 'fuchsia'),
    allowed('settings.view', true) && tool('settings', 'Finance Settings', 'The currency used on bills, reports and exports.', 'settings/currency', Settings, 'slate'),
    allowed('settings.view', true) && !isBranchWorkspace && tool('billing', 'Subscription Billing', 'Your Automation Restaurant plan and payments.', 'billing', CreditCard, 'rose'),
  ].filter(Boolean) as ModuleTool[];

  const rangeKey = `${range.from}:${range.to}`;

  return (
    <div className="mx-auto max-w-7xl space-y-6">
      <ModuleHeader
        icon={Wallet}
        accent="violet"
        title="Finance"
        subtitle="Manage your restaurant's financial operations, expenses and payments."
        actions={
          <ModuleRangePicker
            basePath={`${base}/finance`}
            period={range.period}
            from={range.from}
            to={range.to}
            label={rangeLabel(range.from, range.to)}
            compareLabel={`Compared with ${rangeLabel(range.prevFrom, range.prevTo)}`}
          />
        }
      />

      <Suspense key={`kpi:${rangeKey}`} fallback={<KpiSkeleton />}>
        <FinanceKpis client={t.client} range={range} access={access} base={base} />
      </Suspense>

      <ModuleSection title="Finance Tools" description="Quick access to your financial features and management tools.">
        <ModuleToolGrid tools={tools} />
      </ModuleSection>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.55fr)_minmax(0,1fr)]">
        <Suspense key={`chart:${rangeKey}`} fallback={<ModuleSkeleton className="h-[25rem]" />}>
          <RevenueExpenseSection client={t.client} range={range} access={access} />
        </Suspense>
        <Suspense key={`tx:${rangeKey}`} fallback={<ModuleSkeleton className="h-[25rem]" />}>
          <RecentTransactions client={t.client} range={range} access={access} viewAllHref={`${base}/finance/ledger?${rangeQuery}`} />
        </Suspense>
      </div>
    </div>
  );
}

