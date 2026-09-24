import { notFound } from 'next/navigation';
import { createTenantServerClient } from '@/lib/supabase/tenant-server';
import { gatePortalPage, can } from '@/lib/permissions';
import { ReservationsClient } from './ReservationsClient';

export const dynamic = 'force-dynamic';

export default async function ReservationsPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const t = await createTenantServerClient(slug);
  if (!t) notFound();

  const { role, perms } = await gatePortalPage(t.client, slug, 'tables.view');

  const since = new Date();
  since.setHours(0, 0, 0, 0);

  const { data, error } = await t.client
    .from('reservations')
    .select(
      'id, customer_name, phone, party_size, reserved_at, table_label, occasion, notes, status',
    )
    .gte('reserved_at', since.toISOString())
    .order('reserved_at', { ascending: true })
    .limit(200);

  return (
    <div className="space-y-6 max-w-4xl">
      <h1 className="text-xl font-black">Reservations</h1>
      {error ? (
        <div className="rounded-lg border border-danger/40 bg-danger/10 text-danger p-4 text-xs">
          {error.message}
        </div>
      ) : (
        <ReservationsClient reservations={data ?? []} canEdit={can(perms, role, 'tables.update')} />
      )}
    </div>
  );
}
