'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { createControlPlaneBrowserClient } from '@/lib/supabase/control-plane-client';
import { canAdmin } from '@/lib/adminPermissions';
import { Drawer } from './Drawer';
import { AdminButton, AdminBadge } from './ui';
import { formatCents } from '@/lib/format';

const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

export type DrawerTenant = {
  id: string;
  restaurant_name: string;
  slug: string;
  owner_email: string | null;
  status: string;
  subscriptions: {
    tier: string;
    status: string;
    billing_interval: string;
    current_period_end: string | null;
    stripe_customer_id: string | null;
  } | null;
};

type Invoice = {
  id: string;
  status: string | null;
  amount_paid_cents: number;
  currency: string;
  created: number;
  hosted_invoice_url: string | null;
};

export function RestaurantDetailDrawer({
  tenant,
  onClose,
  role,
  perms,
  planTiers,
}: {
  tenant: DrawerTenant | null;
  onClose: () => void;
  role: string;
  perms: string[];
  planTiers: string[];
}) {
  const router = useRouter();
  const supabase = createControlPlaneBrowserClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [staffCount, setStaffCount] = useState<number | null | 'unavailable'>(null);
  const [invoices, setInvoices] = useState<Invoice[] | null>(null);
  const canManage = canAdmin(perms, role, 'subscriptions.manage');

  useEffect(() => {
    if (!tenant) return;
    setStaffCount(null);
    setInvoices(null);
    setError(null);
    (async () => {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      const headers = { Authorization: `Bearer ${session?.access_token ?? ''}` };

      // Some tenant projects have stale/dead credentials (pre-existing,
      // tracked separately) — a per-tenant call can hang indefinitely
      // rather than error, so this times out client-side rather than
      // leaving the drawer stuck on "Loading…" forever.
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8000);
      fetch(`${API}/api/admin/tenants/${tenant.slug}/summary`, { headers, signal: controller.signal })
        .then((r) => r.json())
        .then((b) => setStaffCount(typeof b.staff_count === 'number' ? b.staff_count : 'unavailable'))
        .catch(() => setStaffCount('unavailable'))
        .finally(() => clearTimeout(timeout));

      const customerId = tenant.subscriptions?.stripe_customer_id;
      if (!customerId) {
        setInvoices([]);
        return;
      }
      fetch(`${API}/api/admin/invoices?customer=${encodeURIComponent(customerId)}`, { headers })
        .then((r) => r.json())
        .then((b) => setInvoices(Array.isArray(b.invoices) ? b.invoices : []))
        .catch(() => setInvoices([]));
    })();
  }, [tenant, supabase]);

  if (!tenant) return null;

  async function action(path: string, body?: Record<string, unknown>) {
    setBusy(true);
    setError(null);
    const {
      data: { session },
    } = await supabase.auth.getSession();
    try {
      const res = await fetch(`${API}/api/admin/subscriptions/${tenant!.id}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session?.access_token ?? ''}` },
        body: JSON.stringify(body ?? {}),
      });
      const b = await res.json().catch(() => ({}));
      if (!res.ok || b.ok === false) {
        setError(b.message ?? b.error ?? 'Action failed');
        return;
      }
      if (b.url) window.open(b.url, '_blank');
      router.refresh();
    } catch {
      setError('Network error.');
    } finally {
      setBusy(false);
    }
  }

  const sub = tenant.subscriptions;

  return (
    <Drawer open={!!tenant} onClose={onClose} title={tenant.restaurant_name} subtitle={`/r/${tenant.slug}`}>
      <div className="space-y-1 text-xs">
        <div className="flex justify-between">
          <span className="text-ink-muted">Owner</span>
          <span>{tenant.owner_email ?? '—'}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-ink-muted">Status</span>
          <AdminBadge status={tenant.status} />
        </div>
        <div className="flex justify-between">
          <span className="text-ink-muted">Staff on file</span>
          <span>{staffCount == null ? 'Loading…' : staffCount === 'unavailable' ? 'Unavailable' : staffCount}</span>
        </div>
      </div>

      <div className="border-t border-white/10 pt-3 space-y-1 text-xs">
        <div className="font-bold text-sm mb-1">Subscription</div>
        {sub ? (
          <>
            <div className="flex justify-between">
              <span className="text-ink-muted">Plan</span>
              <span className="capitalize">{sub.tier} · {sub.billing_interval}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-ink-muted">Status</span>
              <AdminBadge status={sub.status} />
            </div>
            <div className="flex justify-between">
              <span className="text-ink-muted">Renews</span>
              <span>{sub.current_period_end ? new Date(sub.current_period_end).toLocaleDateString() : '—'}</span>
            </div>
          </>
        ) : (
          <p className="text-ink-muted">No subscription on file.</p>
        )}
      </div>

      {canManage && sub && (
        <div className="border-t border-white/10 pt-3 space-y-2">
          <div className="font-bold text-sm mb-1">Actions</div>
          {error && <p className="text-red-400 text-xs">{error}</p>}
          <div className="flex flex-wrap gap-1.5">
            {sub.status !== 'canceled' ? (
              <AdminButton variant="danger" disabled={busy} onClick={() => action('/cancel')}>
                Cancel
              </AdminButton>
            ) : (
              <AdminButton disabled={busy} onClick={() => action('/reactivate')}>
                Reactivate
              </AdminButton>
            )}
            <AdminButton variant="ghost" disabled={busy} onClick={() => action('/extend-trial', { days: 14 })}>
              Extend trial 14d
            </AdminButton>
            <AdminButton variant="ghost" disabled={busy} onClick={() => action('/portal-session')}>
              Open billing portal
            </AdminButton>
          </div>
          {planTiers.length > 1 && (
            <div className="flex flex-wrap gap-1.5 pt-1">
              {planTiers
                .filter((t) => t !== sub.tier)
                .map((t) => (
                  <AdminButton
                    key={t}
                    variant="ghost"
                    disabled={busy}
                    onClick={() => action('/change-plan', { tier: t, billing_interval: sub.billing_interval })}
                  >
                    Move to {t}
                  </AdminButton>
                ))}
            </div>
          )}
        </div>
      )}

      <div className="border-t border-white/10 pt-3">
        <div className="font-bold text-sm mb-1">Invoices</div>
        {invoices == null ? (
          <p className="text-ink-muted text-xs">Loading…</p>
        ) : invoices.length === 0 ? (
          <p className="text-ink-muted text-xs">No invoices found.</p>
        ) : (
          <div className="space-y-1.5">
            {invoices.map((inv) => (
              <div key={inv.id} className="flex items-center justify-between text-xs">
                <span className="text-ink-muted">{new Date(inv.created * 1000).toLocaleDateString()}</span>
                <span className="capitalize">{inv.status}</span>
                <span className="font-semibold">{formatCents(inv.amount_paid_cents)}</span>
                {inv.hosted_invoice_url && (
                  <a href={inv.hosted_invoice_url} target="_blank" rel="noreferrer" className="text-gold hover:underline">
                    View
                  </a>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </Drawer>
  );
}
