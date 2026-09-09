import { notFound, redirect } from 'next/navigation';
import { createTenantServerClient } from '@/lib/supabase/tenant-server';
import { RegisterClient, type Bill } from './RegisterClient';

export const dynamic = 'force-dynamic';

const UNPAID = ['pending', 'in_kitchen', 'ready', 'served'];

export default async function RegisterPage({ params }: { params: Promise<{ slug: string }> }) {
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
      'id, order_number, session_id, table_label, customer_name, status, subtotal_cents, tax_cents, total_cents, created_at, order_lines(name_snapshot, qty, line_total_cents)',
    )
    .in('status', UNPAID)
    .order('created_at', { ascending: true });

  return <RegisterClient initial={(data ?? []) as Bill[]} />;
}
