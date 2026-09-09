import { notFound, redirect } from 'next/navigation';
import { createTenantServerClient } from '@/lib/supabase/tenant-server';
import { KdsBoard, type Ticket } from './KdsBoard';

export const dynamic = 'force-dynamic';

const ACTIVE = ['pending', 'in_kitchen', 'ready'];

export default async function KdsPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const t = await createTenantServerClient(slug);
  if (!t) notFound();

  const {
    data: { user },
  } = await t.client.auth.getUser();
  if (!user) redirect(`/r/${slug}/login`);

  const { data, error } = await t.client
    .from('orders')
    .select(
      'id, order_number, table_label, channel, created_at, status, order_lines(id, name_snapshot, qty, kds_status, modifiers)',
    )
    .in('status', ACTIVE)
    .order('created_at', { ascending: true });

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-black">Kitchen Display</h1>
      {error ? (
        <div className="rounded-lg border border-danger/40 bg-danger/10 text-danger p-4 text-xs">
          {error.message}
        </div>
      ) : (
        <KdsBoard initial={(data ?? []) as Ticket[]} />
      )}
    </div>
  );
}
