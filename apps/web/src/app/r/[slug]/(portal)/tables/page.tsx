import { notFound } from 'next/navigation';
import QRCode from 'qrcode';
import { createTenantServerClient } from '@/lib/supabase/tenant-server';
import { gatePortalPage, can } from '@/lib/permissions';
import { TablesManager, type TableRow } from './TablesManager';

export const dynamic = 'force-dynamic';

const SITE = process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3005';

export default async function TablesPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const t = await createTenantServerClient(slug);
  if (!t) notFound();
  const { role, perms } = await gatePortalPage(t.client, slug, 'tables.view');

  const { data, error } = await t.client
    .from('restaurant_tables')
    .select('id, label, seats, sort_order')
    .order('sort_order');

  const rows: TableRow[] = await Promise.all(
    (data ?? []).map(async (r) => {
      const url = `${SITE}/order/${slug}?table=${encodeURIComponent(r.label)}`;
      const qrSvg = await QRCode.toString(url, {
        type: 'svg',
        margin: 1,
        width: 150,
        color: { dark: '#0f172a', light: '#ffffff' },
      });
      return { ...r, url, qrSvg };
    }),
  );

  return (
    <div className="space-y-6 max-w-4xl">
      <h1 className="text-xl font-black">Tables &amp; QR codes</h1>
      {error ? (
        <div className="rounded-lg border border-danger/40 bg-danger/10 text-danger p-4 text-xs">
          {error.message}
        </div>
      ) : (
        <TablesManager
          rows={rows}
          canEdit={can(perms, role, 'tables.update')}
          canCreate={can(perms, role, 'tables.update') || can(perms, role, 'tables.create')}
        />
      )}
    </div>
  );
}
