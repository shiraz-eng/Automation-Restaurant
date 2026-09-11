import { notFound } from 'next/navigation';
import Link from 'next/link';
import { createTenantServerClient } from '@/lib/supabase/tenant-server';
import { gatePortalPage } from '@/lib/permissions';
import { getTenantConfig } from '@/lib/tenant';
import { PLANS, isPlanTier } from '@automation-restaurant/shared';
import { Card } from '@/components/ui';

export const dynamic = 'force-dynamic';

export default async function BillingPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const t = await createTenantServerClient(slug);
  if (!t) notFound();
  await gatePortalPage(t.client, slug, 'settings.view');

  const config = await getTenantConfig(slug);
  const tier = isPlanTier(config?.tier) ? config!.tier : 'starter';
  const info = PLANS[tier];

  return (
    <div className="space-y-6 max-w-3xl">
      <h1 className="text-xl font-black">Billing</h1>

      <Card className="space-y-4">
        <div className="flex items-start justify-between">
          <div>
            <div className="text-muted text-xs font-semibold">Current plan</div>
            <div className="text-lg font-black">{info.name}</div>
            <div className="text-muted text-xs">{info.blurb}</div>
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
            <dd className="font-semibold">{info.limits.users}</dd>
          </div>
          <div>
            <dt className="text-muted">Branches</dt>
            <dd className="font-semibold">{info.limits.branches}</dd>
          </div>
          <div>
            <dt className="text-muted">Support</dt>
            <dd className="font-semibold">{info.limits.support}</dd>
          </div>
        </dl>
      </Card>

      <Card>
        <h2 className="font-bold text-sm mb-2">Change plan</h2>
        <p className="text-muted text-xs mb-3">
          Upgrades, downgrades and cancellation are handled by our team while payment
          integration is finalised. Your feature access follows your subscription tier
          automatically once changed.
        </p>
        <div className="flex flex-wrap gap-2">
          <Link
            href="/pricing"
            target="_blank"
            className="rounded border border-border px-3 py-1.5 text-xs font-semibold"
          >
            View plans
          </Link>
          <Link
            href="/contact"
            target="_blank"
            className="rounded bg-primary text-primary-fg px-3 py-1.5 text-xs font-semibold"
          >
            Request a change
          </Link>
        </div>
      </Card>

      <Card>
        <h2 className="font-bold text-sm mb-2">Payment history</h2>
        <p className="text-muted text-xs">
          Invoices appear here once Stripe billing is connected.
        </p>
      </Card>
    </div>
  );
}
