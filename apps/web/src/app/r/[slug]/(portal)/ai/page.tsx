import { notFound } from 'next/navigation';
import { createTenantServerClient } from '@/lib/supabase/tenant-server';
import { can, gatePortalPage } from '@/lib/permissions';
import { PlanUpgradePaywall } from '@/components/PlanUpgradePaywall';
import { getTenantEntitlement } from '@/lib/entitlements';
import { AiChat } from './AiChat';
import { AiAssistantPanel } from './AiAssistantPanel';
import { CustomerChats } from './CustomerChats';

export const dynamic = 'force-dynamic';

export default async function AiPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const t = await createTenantServerClient(slug);
  if (!t) notFound();
  const { role, perms } = await gatePortalPage(t.client, slug, 'ai.view');

  const ent = await getTenantEntitlement(t.client, t.config.tier);
  if (!ent.isEntitled('analytics.advanced')) {
    return <PlanUpgradePaywall slug={slug} featureKey="analytics.advanced" currentTier={ent.tier} />;
  }
  const canImportMenu = can(perms, role, 'menu.create');
  const canImportInventory = can(perms, role, 'stock.update');
  const canImportRecipes = can(perms, role, 'inventory.manage_recipes') || can(perms, role, 'finance.manage_recipes');
  const canImportTables = can(perms, role, 'tables.update');
  const canImportSuppliers = can(perms, role, 'supplier.manage');
  const canImportSupplierPrices = can(perms, role, 'supplier.manage');
  const canImportPurchaseOrders = can(perms, role, 'purchases.update');
  const canImportStaff = can(perms, role, 'staff.create');
  const canImportSupplierInvoices = can(perms, role, 'invoices.create');
  const canMatchInvoices = can(perms, role, 'invoices.match');

  return (
    <div className="space-y-4 max-w-3xl">
      <div>
        <h1 className="text-xl font-black">Assistant</h1>
        <p className="text-muted text-xs mt-1">
          Ask anything — today&apos;s numbers, the kitchen, stock, ideas, or a PDF to read or make. It reads
          live data with your permissions and can&apos;t change anything without your confirmation. Every
          chat is saved under History.
        </p>
      </div>
      <AiAssistantPanel
        slug={slug}
        canImportMenu={canImportMenu}
        canImportInventory={canImportInventory}
        canImportRecipes={canImportRecipes}
        canImportTables={canImportTables}
        canImportSuppliers={canImportSuppliers}
        canImportSupplierPrices={canImportSupplierPrices}
        canImportPurchaseOrders={canImportPurchaseOrders}
        canImportStaff={canImportStaff}
        canImportSupplierInvoices={canImportSupplierInvoices}
        canMatchInvoices={canMatchInvoices}
      />
      <AiChat slug={slug} />
      {can(perms, role, 'customers.view') && <CustomerChats />}
    </div>
  );
}
