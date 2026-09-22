import { notFound } from 'next/navigation';
import { createTenantServerClient } from '@/lib/supabase/tenant-server';
import { gatePortalPage } from '@/lib/permissions';
import { getTenantConfig } from '@/lib/tenant';
import { getPlanByTier, isBillingConfigured } from '@/lib/plans';
import { Card } from '@/components/ui';
import { BillingActions } from './BillingActions';
import { BillingAiChat } from './BillingAiChat';

export const dynamic = 'force-dynamic';

export default async function BillingPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const t = await createTenantServerClient(slug);
  if (!t) notFound();
  await gatePortalPage(t.client, slug, 'settings.view', { ownerOnly: true });

  const config = await getTenantConfig(slug);
  const [info, billingConfigured] = await Promise.all([
    getPlanByTier(config?.tier ?? 'starter'),
    isBillingConfigured(),
  ]);

  return (
    <div className="space-y-6 max-w-3xl">
      <h1 className="text-xl font-black">Billing</h1>

      <Card className="space-y-4">
        <div className="flex items-start justify-between">
          <div>
            <div className="text-muted text-xs font-semibold">Current plan</div>
            <div className="text-lg font-black">{info?.name ?? 'Unknown plan'}</div>
            <div className="text-muted text-xs">{info?.blurb}</div>
          </div>
          <span
            className={`text-xs font-bold px-2.5 py-1 rounded-full ${
              config?.subscriptionStatus === 'active'
                ? 'bg-ok/10 text-ok'
                : 'bg-warn/10 text-warn'
            }`}
          >
            {config?.subscriptionStatus ?? 'unknown'}
          </span>
        </div>

        <dl className="grid grid-cols-2 gap-3 text-xs border-t border-border pt-4">
          <div>
            <dt className="text-muted">Billing cycle</dt>
            <dd className="font-semibold capitalize">{config?.billingInterval ?? '—'}</dd>
          </div>
          <div>
            <dt className="text-muted">Users included</dt>
            <dd className="font-semibold">{info?.limits.users ?? '—'}</dd>
          </div>
          <div>
            <dt className="text-muted">Branches</dt>
            <dd className="font-semibold">{info?.limits.branches ?? '—'}</dd>
          </div>
          <div>
            <dt className="text-muted">Support</dt>
            <dd className="font-semibold">{info?.limits.support ?? '—'}</dd>
          </div>
        </dl>
      </Card>

      <BillingActions slug={slug} billingConfigured={billingConfigured} />
      <BillingAiChat slug={slug} restaurantName={t.config.restaurantName} />
    </div>
  );
}
