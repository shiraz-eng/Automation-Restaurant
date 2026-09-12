import { notFound } from 'next/navigation';
import { createTenantServerClient } from '@/lib/supabase/tenant-server';
import { can, gatePortalPage } from '@/lib/permissions';
import { AiChat } from './AiChat';
import { AiAssistantPanel } from './AiAssistantPanel';

export const dynamic = 'force-dynamic';

export default async function AiPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const t = await createTenantServerClient(slug);
  if (!t) notFound();
  const { role, perms } = await gatePortalPage(t.client, slug, 'ai.view');
  const canImportMenu = can(perms, role, 'menu.create');
  const canImportInventory = can(perms, role, 'stock.update');
  const canImportRecipes = can(perms, role, 'inventory.manage_recipes') || can(perms, role, 'finance.manage_recipes');
  const canImportTables = can(perms, role, 'tables.update');
  const canImportSuppliers = can(perms, role, 'supplier.manage');

  return (
    <div className="space-y-4 max-w-3xl">
      <div>
        <h1 className="text-xl font-black">Assistant</h1>
        <p className="text-muted text-xs mt-1">
          Ask about today&apos;s numbers, the kitchen, stock or feedback. It reads live data with
          your permissions — it can&apos;t change anything without your confirmation.
        </p>
      </div>
      <AiAssistantPanel
        slug={slug}
        canImportMenu={canImportMenu}
        canImportInventory={canImportInventory}
        canImportRecipes={canImportRecipes}
        canImportTables={canImportTables}
        canImportSuppliers={canImportSuppliers}
      />
      <AiChat slug={slug} />
    </div>
  );
}
