import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { createTenantServerClient } from '@/lib/supabase/tenant-server';
import { gatePortalPage, can } from '@/lib/permissions';
import { PriorityManager, type PriorityRow, type MenuItemOption, type AvailabilityRow } from './PriorityManager';
import type { LevelAllocation } from './LevelAllocationEditor';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Priority Allocation' };

export default async function PriorityAllocationPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const t = await createTenantServerClient(slug);
  if (!t) notFound();

  const { role, perms } = await gatePortalPage(t.client, slug, 'availability.view');
  const canManage = can(perms, role, 'availability.update');

  const [{ data: priorities, error }, { data: menuItems }, { data: availability }, { data: settings }, { data: levels }] = await Promise.all([
    t.client
      .from('product_priority')
      .select('id, menu_item_id, priority_level, priority_rank, updated_at, menu_items(name, category_id)')
      .order('priority_level')
      .order('priority_rank'),
    t.client.from('menu_items').select('id, name, category_id').order('name'),
    t.client.from('product_availability').select('menu_item_id, variant_id, status, producible_qty, reason'),
    t.client.rpc('get_priority_allocation_enabled'),
    t.client.from('priority_level_allocation').select('priority_level, allocation_pct, is_active'),
  ]);

  return (
    <div className="space-y-6 max-w-5xl">
      <div>
        <h1 className="text-xl font-black">Priority Allocation</h1>
        <p className="text-muted text-xs mt-1">
          When several products share the same scarce ingredient, this decides who gets it first. Drag products
          within a level to set the exact order; products with no priority set here are served last, after
          everything below, in the order the recipe-driven availability engine already computes for them.
        </p>
      </div>
      {error ? (
        <div className="rounded-lg border border-danger/40 bg-danger/10 text-danger p-4 text-xs">{error.message}</div>
      ) : (
        <PriorityManager
          slug={slug}
          priorities={(priorities ?? []) as unknown as PriorityRow[]}
          menuItems={(menuItems ?? []) as MenuItemOption[]}
          availability={(availability ?? []) as AvailabilityRow[]}
          canManage={canManage}
          allocationEnabled={settings === true}
          levelAllocation={(levels ?? []) as LevelAllocation[]}
        />
      )}
    </div>
  );
}
