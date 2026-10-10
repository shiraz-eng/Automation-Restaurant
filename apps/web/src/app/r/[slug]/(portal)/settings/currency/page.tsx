import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { createTenantServerClient } from '@/lib/supabase/tenant-server';
import { gatePortalPage, can } from '@/lib/permissions';
import { CurrencySettings } from './CurrencySettings';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Currency' };

export default async function CurrencyPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const t = await createTenantServerClient(slug);
  if (!t) notFound();

  const { role, perms } = await gatePortalPage(t.client, slug, 'settings.view', { ownerOnly: true });
  const { data, error } = await t.client.from('business_settings').select('currency_code').eq('id', true).maybeSingle();

  return (
    <div className="space-y-6 max-w-2xl">
      <div>
        <h1 className="text-xl font-black">Currency</h1>
        <p className="text-muted text-xs mt-1">The currency your restaurant trades in.</p>
      </div>
      {error ? (
        <div className="rounded-lg border border-danger/40 bg-danger/10 text-danger p-4 text-xs">{error.message}</div>
      ) : (
        <CurrencySettings currency={data?.currency_code ?? 'USD'} canEdit={can(perms, role, 'settings.update')} />
      )}
    </div>
  );
}
