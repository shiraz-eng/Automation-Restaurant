import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { createTenantServerClient } from '@/lib/supabase/tenant-server';
import { gatePortalPage, can } from '@/lib/permissions';
import { TaxSettings } from './TaxSettings';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Tax' };

export default async function TaxPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const t = await createTenantServerClient(slug);
  if (!t) notFound();

  const { role, perms } = await gatePortalPage(t.client, slug, 'settings.view', { ownerOnly: true });
  const { data, error } = await t.client.from('business_settings').select('tax_enabled, tax_rate_bps').eq('id', true).maybeSingle();

  return (
    <div className="space-y-6 max-w-2xl">
      <div>
        <h1 className="text-xl font-black">Tax</h1>
        <p className="text-muted text-xs mt-1">Sales tax charged on every new order — enforced by the database, not just the screen.</p>
      </div>
      {error ? (
        <div className="rounded-lg border border-danger/40 bg-danger/10 text-danger p-4 text-xs">{error.message}</div>
      ) : (
        <TaxSettings taxEnabled={data?.tax_enabled ?? true} taxRateBps={data?.tax_rate_bps ?? 800} canEdit={can(perms, role, 'settings.update')} />
      )}
    </div>
  );
}
