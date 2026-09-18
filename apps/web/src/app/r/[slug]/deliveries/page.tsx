import { notFound, redirect } from 'next/navigation';
import { createTenantServerClient } from '@/lib/supabase/tenant-server';
import { can } from '@/lib/permissions';
import { PortalAiWidget } from '@/components/PortalAiWidget';
import { DeliveriesClient, type Delivery } from './DeliveriesClient';

export const dynamic = 'force-dynamic';

const ACTIVE = ['pending', 'in_kitchen', 'ready', 'served'];

export default async function DeliveriesPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const t = await createTenantServerClient(slug);
  if (!t) notFound();
  const {
    data: { user },
  } = await t.client.auth.getUser();
  if (!user) redirect(`/r/${slug}/login`);

  const meta = (user.app_metadata ?? {}) as { role?: string; permissions?: string[] };
  const role = meta.role ?? 'owner';
  const perms = Array.isArray(meta.permissions) ? meta.permissions : [];
  const canUseAi = can(perms, role, 'ai.view');

  const { data } = await t.client
    .from('orders')
    .select(
      'id, order_number, customer_name, table_label, status, total_cents, created_at, order_lines(name_snapshot, qty)',
    )
    .eq('channel', 'delivery')
    .in('status', ACTIVE)
    .order('created_at', { ascending: true });

  return (
    <>
      <DeliveriesClient initial={(data ?? []) as Delivery[]} />
      {canUseAi && <PortalAiWidget slug={slug} />}
    </>
  );
}
