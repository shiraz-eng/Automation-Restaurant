'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { usePortalSupabase } from '@/components/PortalProvider';
import { Button, Card } from '@/components/ui';
import { formatCents } from '@/lib/format';

const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

const PLANS = [
  {
    tier: 'starter',
    name: 'Starter',
    price: '$49',
    period: '/mo',
    annualPrice: '$39',
    blurb: 'For small restaurants & cafes',
    features: ['Up to 5 staff accounts', 'Up to 20 tables', 'POS & ordering', 'QR menu ordering', 'Basic sales reports'],
  },
  {
    tier: 'growth',
    name: 'Professional',
    price: '$129',
    period: '/mo',
    annualPrice: '$103',
    blurb: 'For fast-growing restaurants',
    popular: true,
    features: [
      'Up to 20 staff accounts',
      'Unlimited tables',
      'Kitchen Display (KDS)',
      'Inventory & recipe costing',
      'Staff attendance & clock-in',
      'AI Assistant & Smart Import',
    ],
  },
  {
    tier: 'enterprise',
    name: 'Enterprise',
    price: '$299',
    period: '/mo',
    annualPrice: '$239',
    blurb: 'For multi-branch restaurant groups',
    features: [
      'Unlimited staff accounts',
      'Unlimited tables & branches',
      'Custom portals for stations',
      'Automated low-stock reordering',
      'Full financial analytics & P&L',
      'Dedicated 24/7 support',
    ],
  },
];

type Invoice = {
  id: string;
  status: string | null;
  amount_due_cents: number;
  amount_paid_cents: number;
  currency: string;
  created: number;
  hosted_invoice_url: string | null;
  invoice_pdf: string | null;
};

/** "Manage billing" (a real Stripe-hosted Customer Portal session), plan upgrade options,
 *  and this restaurant's own invoice history — both proxy Stripe directly through
 *  apps/api/src/routes/billing.ts, never a second, locally-stored copy. */
export function BillingActions({
  slug,
  billingConfigured,
  currentTier = 'starter',
  billingInterval = 'monthly',
}: {
  slug: string;
  billingConfigured: boolean;
  currentTier?: string;
  billingInterval?: string;
}) {
  const router = useRouter();
  const supabase = usePortalSupabase();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [upgradingTier, setUpgradingTier] = useState<string | null>(null);
  const [upgradeSuccess, setUpgradeSuccess] = useState<string | null>(null);
  const [upgradeError, setUpgradeError] = useState<string | null>(null);
  const [invoices, setInvoices] = useState<Invoice[] | null>(null);
  const [canceling, setCanceling] = useState(false);
  const [cancelResult, setCancelResult] = useState<string | null>(null);
  const [cancelError, setCancelError] = useState<string | null>(null);

  useEffect(() => {
    if (!billingConfigured) {
      setInvoices([]);
      return;
    }
    let cancelled = false;
    (async () => {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      const res = await fetch(`${API}/api/billing/invoices?slug=${encodeURIComponent(slug)}`, {
        headers: { Authorization: `Bearer ${session?.access_token ?? ''}` },
      });
      const body = await res.json().catch(() => ({ invoices: [] }));
      if (!cancelled) setInvoices(res.ok ? (body.invoices ?? []) : []);
    })();
    return () => {
      cancelled = true;
    };
  }, [supabase, slug, billingConfigured]);

  async function openPortal() {
    setBusy(true);
    setError(null);
    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      const res = await fetch(`${API}/api/billing/portal-session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session?.access_token ?? ''}` },
        body: JSON.stringify({ slug }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !body.url) {
        setError(body.message ?? 'Could not open billing management right now.');
        return;
      }
      window.location.href = body.url;
    } catch {
      setError('Network error — try again.');
    } finally {
      setBusy(false);
    }
  }

  async function cancelSubscription() {
    if (
      !confirm(
        billingConfigured
          ? 'Cancel your subscription? You’ll keep access until the end of the current billing period, then lose access to paid features.'
          : 'Cancel your subscription? This takes effect immediately.',
      )
    ) {
      return;
    }
    setCanceling(true);
    setCancelError(null);
    setCancelResult(null);
    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      const res = await fetch(`${API}/api/billing/cancel`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session?.access_token ?? ''}` },
        body: JSON.stringify({ slug }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setCancelError(body.message ?? 'Could not cancel your subscription right now.');
        return;
      }
      setCancelResult(body.message);
    } catch {
      setCancelError('Network error — try again.');
    } finally {
      setCanceling(false);
    }
  }

  async function changePlan(targetTier: string) {
    if (targetTier === currentTier) return;
    setUpgradingTier(targetTier);
    setUpgradeError(null);
    setUpgradeSuccess(null);
    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      const res = await fetch(`${API}/api/billing/change-plan`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session?.access_token ?? ''}`,
        },
        body: JSON.stringify({ slug, tier: targetTier, billing_interval: billingInterval }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setUpgradeError(body.message ?? 'Could not update plan right now.');
        return;
      }
      setUpgradeSuccess(body.message ?? 'Plan updated successfully!');
      router.refresh();
    } catch {
      setUpgradeError('Network error — please try again.');
    } finally {
      setUpgradingTier(null);
    }
  }

  return (
    <>
      <Card className="space-y-4">
        <div>
          <h2 className="font-bold text-sm mb-1">Upgrade or change plan</h2>
          <p className="text-muted text-xs">
            Select a plan to immediately unlock features for your restaurant workspace.
          </p>
        </div>

        {upgradeError && <div className="rounded border border-danger/40 bg-danger/10 text-danger p-3 text-xs">{upgradeError}</div>}
        {upgradeSuccess && <div className="rounded border border-ok/40 bg-ok/10 text-ok p-3 text-xs">{upgradeSuccess}</div>}

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 pt-1">
          {PLANS.map((p) => {
            const isCurrent = p.tier === currentTier;
            const price = billingInterval === 'annual' ? p.annualPrice : p.price;
            return (
              <div
                key={p.tier}
                className={`rounded-lg border p-4 flex flex-col justify-between transition-all ${
                  isCurrent
                    ? 'border-primary ring-1 ring-primary bg-surface'
                    : 'border-border bg-surface hover:border-border/80'
                }`}
              >
                <div>
                  <div className="flex items-center justify-between mb-1">
                    <span className="font-bold text-sm">{p.name}</span>
                    {isCurrent && (
                      <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-primary text-primary-fg">
                        Active
                      </span>
                    )}
                  </div>
                  <div className="flex items-baseline gap-1 my-2">
                    <span className="text-xl font-black">{price}</span>
                    <span className="text-xs text-muted">{p.period}</span>
                  </div>
                  <p className="text-[11px] text-muted mb-3">{p.blurb}</p>
                  <ul className="space-y-1.5 text-[11px] border-t border-border pt-3 mb-4">
                    {p.features.map((feat) => (
                      <li key={feat} className="flex items-center gap-1.5">
                        <span className="text-ok font-bold">✓</span>
                        <span>{feat}</span>
                      </li>
                    ))}
                  </ul>
                </div>

                <div>
                  {isCurrent ? (
                    <div className="w-full text-center text-xs font-semibold py-1.5 rounded bg-muted/10 text-muted">
                      Current Plan
                    </div>
                  ) : (
                    <Button
                      variant="primary"
                      disabled={upgradingTier !== null}
                      onClick={() => changePlan(p.tier)}
                      className="w-full"
                    >
                      {upgradingTier === p.tier
                        ? 'Updating…'
                        : p.tier === 'enterprise' || (p.tier === 'growth' && currentTier === 'starter')
                        ? `Upgrade to ${p.name}`
                        : `Switch to ${p.name}`}
                    </Button>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3 text-xs">
          <span className="text-muted">
            {billingConfigured
              ? 'Invoices, payment methods, and tax receipts are managed securely.'
              : 'Direct self-service plan updates.'}
          </span>
          <div className="flex items-center gap-2">
            {billingConfigured && (
              <Button onClick={openPortal} disabled={busy} variant="ghost">
                {busy ? 'Opening…' : 'Manage Stripe customer portal'}
              </Button>
            )}
            <a
              href="/pricing"
              target="_blank"
              rel="noreferrer"
              className="rounded border border-border px-3 py-1.5 text-xs font-semibold inline-flex items-center hover:bg-main"
            >
              Compare all plans
            </a>
          </div>
        </div>
      </Card>

      <Card>
        <h2 className="font-bold text-sm mb-2">Cancel subscription</h2>
        <p className="text-muted text-xs mb-3">
          {billingConfigured
            ? 'You keep access through the end of your current billing period, then the subscription ends — no partial refund for time already paid.'
            : 'Cancellation takes effect immediately.'}
        </p>
        {cancelError && <p className="text-danger text-xs mb-2">{cancelError}</p>}
        {cancelResult && <p className="text-ok text-xs mb-2">{cancelResult}</p>}
        <Button variant="danger" onClick={cancelSubscription} disabled={canceling || !!cancelResult}>
          {canceling ? 'Canceling…' : cancelResult ? 'Canceled' : 'Cancel subscription'}
        </Button>
      </Card>

      <Card>
        <h2 className="font-bold text-sm mb-2">Payment history</h2>
        {invoices === null ? (
          <p className="text-muted text-xs">Loading…</p>
        ) : invoices.length === 0 ? (
          <p className="text-muted text-xs">
            {billingConfigured ? 'No invoices yet.' : 'Invoices appear here once billing is connected.'}
          </p>
        ) : (
          <div className="space-y-2">
            {invoices.map((inv) => (
              <div key={inv.id} className="flex items-center justify-between text-xs border-b border-border pb-2 last:border-0 last:pb-0">
                <div>
                  <div className="font-semibold">{new Date(inv.created * 1000).toLocaleDateString()}</div>
                  <div className="text-muted capitalize">{inv.status}</div>
                </div>
                <div className="text-right">
                  <div className="font-semibold">{formatCents(inv.amount_paid_cents)}</div>
                  {inv.hosted_invoice_url && (
                    <a href={inv.hosted_invoice_url} target="_blank" rel="noreferrer" className="text-primary hover:underline">
                      View
                    </a>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>
    </>
  );
}
