import { notFound } from 'next/navigation';
import { createTenantServerClient } from '@/lib/supabase/tenant-server';
import { gatePortalPage, can } from '@/lib/permissions';
import { DealsWorkspace } from './DealsWorkspace';
import { DEAL_SELECT, MENU_PICK_SELECT, type DealRow, type MenuPick } from './dealTypes';

export const dynamic = 'force-dynamic';

export default async function DealsPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const t = await createTenantServerClient(slug);
  if (!t) notFound();
  const { role, perms } = await gatePortalPage(t.client, slug, 'deals.view');

  const [{ data: deals, error }, { data: items }, { data: settings }] = await Promise.all([
    t.client.from('deals').select(DEAL_SELECT).order('sort_order').order('created_at', { ascending: false }),
    t.client.from('menu_items').select(MENU_PICK_SELECT).order('name'),
    t.client.from('business_settings').select('currency_code').eq('id', true).maybeSingle(),
  ]);

  return (
    <div className="max-w-7xl">
      {error ? (
        <div className="rounded-lg border border-danger/40 bg-danger/10 text-danger p-4 text-xs">{error.message}</div>
      ) : (
        <DealsWorkspace
          deals={(deals ?? []) as unknown as DealRow[]}
          menu={(items ?? []) as unknown as MenuPick[]}
          currency={(settings as { currency_code?: string } | null)?.currency_code ?? 'USD'}
          caps={{
            create: can(perms, role, 'deals.update') || can(perms, role, 'deals.create'),
            edit: can(perms, role, 'deals.update'),
            archive: can(perms, role, 'deals.update') || can(perms, role, 'deals.archive'),
          }}
          canViewCost={
            can(perms, role, 'inventory.view_cost') || can(perms, role, 'finance.view_cogs') || can(perms, role, 'finance.view_profit')
          }
        />
      )}
    </div>
  );
}
