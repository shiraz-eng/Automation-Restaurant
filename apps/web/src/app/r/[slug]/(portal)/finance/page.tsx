import type { Metadata } from 'next';
import { Suspense } from 'react';
import { notFound } from 'next/navigation';
import { Wallet } from 'lucide-react';
import { createTenantServerClient } from '@/lib/supabase/tenant-server';
import { loadTenantCurrency } from '@/lib/currencyServer';
import { gatePortalPage, can } from '@/lib/permissions';
import { getTenantEntitlement } from '@/lib/entitlements';
import { PlanUpgradePaywall } from '@/components/PlanUpgradePaywall';
import { rangeLabel, resolveFinancePeriod } from '@/lib/financePeriod';
import { ModuleHeader, ModuleSection, ModuleSkeleton, ModuleToolGrid, toModuleTools } from '@/components/module/ModuleLanding';
import { moduleByKey, visibleTools } from '@/lib/modules';
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

  // The Finance tiles from the shared module list (lib/modules.ts), with the
  // same gates as the sidebar. The period carries over to the ledger-based screens.
  const finance = moduleByKey('finance')!;
  const withRange = new Set(['overview', 'expenses', 'ledger']);
  const tools = toModuleTools(
    visibleTools(finance, { role, perms, isEntitled: ent.isEntitled, isBranchWorkspace: Boolean(t.config.parentSlug) }),
    base,
    (tool) => (withRange.has(tool.key) ? rangeQuery : ''),
  );

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

