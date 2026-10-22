import type { Metadata } from 'next';
import { Suspense } from 'react';
import { notFound, redirect } from 'next/navigation';
import { createTenantServerClient } from '@/lib/supabase/tenant-server';
import { loadTenantCurrency } from '@/lib/currencyServer';
import { gatePortalPage, can } from '@/lib/permissions';
import { getTenantEntitlement } from '@/lib/entitlements';
import { moduleByKey, visibleTools } from '@/lib/modules';
import { ModuleHeader, ModuleSection, ModuleToolGrid, toModuleTools } from '@/components/module/ModuleLanding';
import { KPI_CARDS, ModuleKpiSkeleton, ModuleKpis } from './ModuleKpis';

export const dynamic = 'force-dynamic';

export async function generateMetadata({ params }: { params: Promise<{ module: string }> }): Promise<Metadata> {
  return { title: moduleByKey((await params).module)?.label ?? 'Module' };
}

/**
 * A module's landing page (POS & Orders, Kitchen, Menu, Inventory, Suppliers,
 * Staff, Analytics, AI, Settings): its KPIs and a tile for each of its screens
 * the viewer may open. Finance has its own, richer landing at /finance.
 */
export default async function ModuleLandingPage({ params }: { params: Promise<{ slug: string; module: string }> }) {
  const { slug, module: key } = await params;
  const m = moduleByKey(key);
  if (!m) notFound();
  if (m.landing !== `modules/${m.key}`) redirect(`/r/${slug}/${m.landing}`);

  const t = await createTenantServerClient(slug);
  if (!t) notFound();
  await loadTenantCurrency(t.client);
  const { role, perms } = await gatePortalPage(t.client, slug, '');
  const ent = await getTenantEntitlement(t.client, t.config.tier);
  const isBranchWorkspace = Boolean(t.config.parentSlug);
  const base = `/r/${slug}`;

  const tools = visibleTools(m, { role, perms, isEntitled: ent.isEntitled, isBranchWorkspace });
  // Nothing in this module is open to this login: back to where they start.
  if (tools.length === 0) redirect(base);

  const { data: settings } = await t.client.from('business_settings').select('timezone').maybeSingle();
  let timeZone = 'UTC';
  try {
    if (settings?.timezone) {
      new Intl.DateTimeFormat('en-US', { timeZone: settings.timezone });
      timeZone = settings.timezone;
    }
  } catch {
    /* unknown zone name — stay on UTC */
  }

  return (
    <div className="mx-auto max-w-7xl space-y-6">
      <ModuleHeader icon={m.icon} accent={m.accent} title={m.label} subtitle={m.subtitle} />

      {KPI_CARDS[m.key] > 0 && (
        <Suspense fallback={<ModuleKpiSkeleton cards={KPI_CARDS[m.key]} />}>
          <ModuleKpis
            module={m.key}
            ctx={{
              client: t.client,
              can: (k) => can(perms, role, k),
              base,
              timeZone,
              tier: t.config.tier ?? null,
              subscriptionStatus: t.config.subscriptionStatus ?? null,
              isOwner: role === 'owner',
              isBranchWorkspace,
            }}
          />
        </Suspense>
      )}

      <ModuleSection title={`${m.label} Tools`} description="Open any of this module's screens.">
        <ModuleToolGrid tools={toModuleTools(tools, base)} />
      </ModuleSection>
    </div>
  );
}
