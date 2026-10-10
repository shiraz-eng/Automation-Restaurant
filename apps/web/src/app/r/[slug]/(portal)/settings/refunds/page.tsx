import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { createTenantServerClient } from '@/lib/supabase/tenant-server';
import { gatePortalPage, can } from '@/lib/permissions';
import { RefundApprovalSettings } from './RefundApprovalSettings';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Refund approvals' };

export default async function RefundApprovalsPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const t = await createTenantServerClient(slug);
  if (!t) notFound();

  const { role, perms } = await gatePortalPage(t.client, slug, 'settings.view', { ownerOnly: true });
  const { data, error } = await t.client
    .from('business_settings')
    .select('max_refund_without_approval_cents')
    .eq('id', true)
    .maybeSingle();

  return (
    <div className="space-y-6 max-w-2xl">
      <div>
        <h1 className="text-xl font-black">Refund approvals</h1>
        <p className="text-muted text-xs mt-1">How large a refund staff can give before someone with refund approval must sign it off.</p>
      </div>
      {error ? (
        <div className="rounded-lg border border-danger/40 bg-danger/10 text-danger p-4 text-xs">{error.message}</div>
      ) : (
        <RefundApprovalSettings
          slug={slug}
          maxRefundWithoutApprovalCents={data?.max_refund_without_approval_cents ?? null}
          canEdit={can(perms, role, 'settings.update')}
        />
      )}
    </div>
  );
}
