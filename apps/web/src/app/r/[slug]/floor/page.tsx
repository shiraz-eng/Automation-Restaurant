import { notFound, redirect } from 'next/navigation';
import { createTenantServerClient } from '@/lib/supabase/tenant-server';
import { can } from '@/lib/permissions';
import { PortalAiWidget } from '@/components/PortalAiWidget';
import { FloorClient, type FloorOrder } from './FloorClient';

export const dynamic = 'force-dynamic';

const ACTIVE = ['pending', 'in_kitchen', 'ready', 'served'];

export default async function FloorPage({ params }: { params: Promise<{ slug: string }> }) {
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
      'id, order_number, table_label, customer_name, status, total_cents, created_at, order_lines(id, name_snapshot, qty, kds_status)',
    )
    .in('status', ACTIVE)
    .order('created_at', { ascending: true });

  return (
    <>
      <FloorClient initial={(data ?? []) as FloorOrder[]} />
      {canUseAi && <PortalAiWidget slug={slug} />}
    </>
  );
}
