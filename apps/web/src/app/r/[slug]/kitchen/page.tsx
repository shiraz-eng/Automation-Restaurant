import { notFound, redirect } from 'next/navigation';
import { createTenantServerClient } from '@/lib/supabase/tenant-server';
import { KitchenBoard, type KitchenTicket } from './KitchenBoard';

export const dynamic = 'force-dynamic';

const ACTIVE = ['pending', 'in_kitchen', 'ready'];

export default async function KitchenPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const t = await createTenantServerClient(slug);
  if (!t) notFound();

  const {
    data: { user },
  } = await t.client.auth.getUser();
  if (!user) redirect(`/r/${slug}/login`);

  const { data } = await t.client
    .from('orders')
    .select(
      'id, order_number, table_label, customer_name, channel, created_at, status, customer_note, order_lines(id, name_snapshot, qty, kds_status, modifiers, customer_note)',
    )
    .in('status', ACTIVE)
    .order('created_at', { ascending: true });

  return <KitchenBoard initial={(data ?? []) as KitchenTicket[]} />;
}
