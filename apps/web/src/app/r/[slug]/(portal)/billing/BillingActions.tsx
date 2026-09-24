'use client';

import { useEffect, useState } from 'react';
import { usePortalSupabase } from '@/components/PortalProvider';
import { Button, Card } from '@/components/ui';
import { formatCents } from '@/lib/format';

const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

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

/** "Manage billing" (a real Stripe-hosted Customer Portal session) and this
 *  restaurant's own invoice history — both proxy Stripe directly through
 *  apps/api/src/routes/billing.ts, never a second, locally-stored copy. */
export function BillingActions({ slug, billingConfigured }: { slug: string; billingConfigured: boolean }) {
  const supabase = usePortalSupabase();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
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

  return (
    <>
      <Card>
        <h2 className="font-bold text-sm mb-2">Change plan</h2>
        <p className="text-muted text-xs mb-3">
          {billingConfigured
            ? 'Change plans, update your payment method, or cancel — handled securely by our payment provider.'
            : 'Upgrades, downgrades and cancellation are handled by our team while payment integration is finalised.'}
        </p>
        {error && <p className="text-danger text-xs mb-2">{error}</p>}
        <div className="flex flex-wrap gap-2">
          {billingConfigured && (
            <Button onClick={openPortal} disabled={busy}>
              {busy ? 'Opening…' : 'Manage billing'}
            </Button>
          )}
          <a
            href="/pricing"
            target="_blank"
            rel="noreferrer"
            className="rounded border border-border px-3 py-1.5 text-xs font-semibold inline-flex items-center"
          >
            View plans
          </a>
          <a
            href="/contact"
            target="_blank"
            rel="noreferrer"
            className="rounded border border-border px-3 py-1.5 text-xs font-semibold inline-flex items-center"
          >
            Contact support
          </a>
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
