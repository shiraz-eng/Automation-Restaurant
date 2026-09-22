import { notFound } from 'next/navigation';
import { createTenantServerClient } from '@/lib/supabase/tenant-server';
import { gatePortalPage } from '@/lib/permissions';
import { StaffManager } from '@/components/StaffManager';

export const dynamic = 'force-dynamic';

export default async function StaffPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const t = await createTenantServerClient(slug);
  if (!t) notFound();

  await gatePortalPage(t.client, slug, 'staff.view');

  const { data, error } = await t.client
    .from('memberships')
    .select('id, email, full_name, role, status, created_at, shift_start_time')
    .order('created_at', { ascending: true });

  return (
    <div className="space-y-6 max-w-3xl">
      <h1 className="text-xl font-black">Staff</h1>
      {error ? (
        <div className="rounded-lg border border-danger/40 bg-danger/10 text-danger p-4 text-xs">
          {error.message}
        </div>
      ) : (
        <StaffManager staff={data ?? []} />
      )}
    </div>
  );
}
