import { notFound } from 'next/navigation';
import { createTenantServerClient } from '@/lib/supabase/tenant-server';
import { gatePortalPage, can } from '@/lib/permissions';
import { PoliciesManager } from './PoliciesManager';

export const dynamic = 'force-dynamic';

export default async function PoliciesPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const t = await createTenantServerClient(slug);
  if (!t) notFound();

  const { role, perms } = await gatePortalPage(t.client, slug, 'settings.view', { ownerOnly: true });
  const canEdit = can(perms, role, 'settings.update');

  const { data, error } = await t.client
    .from('business_settings')
    .select('max_refund_without_approval_cents, receipt_logo_url, receipt_footer_text, receipt_template_html')
    .eq('id', true)
    .maybeSingle();

  return (
    <div className="space-y-6 max-w-2xl">
      <div>
        <h1 className="text-xl font-black">Policies</h1>
        <p className="text-muted text-xs mt-1">
          Configurable approval rules — enforced by the database itself, not just by which buttons a screen shows.
        </p>
      </div>
      {error ? (
        <div className="rounded-lg border border-danger/40 bg-danger/10 text-danger p-4 text-xs">{error.message}</div>
      ) : (
        <PoliciesManager
          slug={slug}
          maxRefundWithoutApprovalCents={data?.max_refund_without_approval_cents ?? null}
          receiptLogoUrl={data?.receipt_logo_url ?? null}
          receiptFooterText={data?.receipt_footer_text ?? null}
          receiptTemplateHtml={data?.receipt_template_html ?? null}
          canEdit={canEdit}
        />
      )}
    </div>
  );
}
