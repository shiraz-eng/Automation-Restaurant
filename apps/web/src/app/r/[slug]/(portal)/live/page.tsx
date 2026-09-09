import { notFound, redirect } from 'next/navigation';
import { createTenantServerClient } from '@/lib/supabase/tenant-server';
import { LiveBoard, type LiveOrder, type FeedbackRow } from './LiveBoard';

export const dynamic = 'force-dynamic';

export default async function LivePage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const t = await createTenantServerClient(slug);
  if (!t) notFound();
  const {
    data: { user },
  } = await t.client.auth.getUser();
  if (!user) redirect(`/r/${slug}/login`);

  const since = new Date();
  since.setHours(0, 0, 0, 0);

  const [{ data: orders }, { data: feedback }] = await Promise.all([
    t.client
      .from('orders')
      .select('id, order_number, table_label, status, total_cents, created_at')
      .gte('created_at', since.toISOString())
      .order('created_at', { ascending: false })
      .limit(100),
    t.client
      .from('feedback')
      .select('id, guest_name, table_label, overall, comment, created_at')
      .order('created_at', { ascending: false })
      .limit(20),
  ]);

  return (
    <div className="space-y-6 max-w-5xl">
      <h1 className="text-xl font-black">Live operations</h1>
      <LiveBoard
        initialOrders={(orders ?? []) as LiveOrder[]}
        initialFeedback={(feedback ?? []) as FeedbackRow[]}
      />
    </div>
  );
}
