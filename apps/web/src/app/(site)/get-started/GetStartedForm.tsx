'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { PlanTier } from '@automation-restaurant/shared';

const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';
const inputCls =
  'mt-1 w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm outline-none focus:border-primary';

export function GetStartedForm({
  plan,
  cycle,
}: {
  plan: PlanTier;
  cycle: 'monthly' | 'annual';
}) {
  const router = useRouter();
  const [f, setF] = useState({
    restaurant_name: '',
    owner_name: '',
    owner_email: '',
    phone: '',
    country: '',
    address: '',
    branch_name: 'Main',
    table_count: '',
  });
  const [agree, setAgree] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setF((s) => ({ ...s, [k]: e.target.value }));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!agree) return setError('Please accept the Terms & Conditions to continue.');

    setBusy(true);
    try {
      const res = await fetch(`${API}/api/onboarding/signup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          restaurant_name: f.restaurant_name.trim(),
          owner_name: f.owner_name.trim() || undefined,
          owner_email: f.owner_email.trim(),
          phone: f.phone.trim() || undefined,
          country: f.country.trim() || undefined,
          address: f.address.trim() || undefined,
          branch_name: f.branch_name.trim() || undefined,
          table_count: f.table_count ? Number(f.table_count) : undefined,
          plan,
          billing_interval: cycle,
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(body.message ?? body.error ?? 'Could not start checkout.');
        return;
      }
      if (body.checkout_url) {
        // Real payment: hand off to Stripe; provisioning runs on the webhook.
        window.location.href = body.checkout_url;
        return;
      }
      if (body.pay_url) {
        // Mock mode: our own card page confirms the charge.
        window.location.href = body.pay_url;
        return;
      }
      if (body.connect_url) {
        // Payment done; owner authorizes their own Supabase org next.
        window.location.href = body.connect_url;
        return;
      }
      if (body.slug) {
        // Simulated payment accepted server-side → workspace is provisioning.
        router.push(`/onboarding/${body.slug}`);
        return;
      }
      setError('Unexpected response from the server.');
    } catch {
      setError('Network error. Try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-6">
      <fieldset className="space-y-3">
        <legend className="font-bold text-sm mb-1">Restaurant information</legend>
        <div className="grid sm:grid-cols-2 gap-3">
          <L label="Restaurant name">
            <input required value={f.restaurant_name} onChange={set('restaurant_name')} className={inputCls} />
          </L>
          <L label="Owner / manager name">
            <input value={f.owner_name} onChange={set('owner_name')} className={inputCls} />
          </L>
          <L label="Business email">
            <input type="email" required value={f.owner_email} onChange={set('owner_email')} className={inputCls} />
          </L>
          <L label="Phone">
            <input value={f.phone} onChange={set('phone')} className={inputCls} />
          </L>
          <L label="Country">
            <input value={f.country} onChange={set('country')} className={inputCls} />
          </L>
          <L label="Address">
            <input value={f.address} onChange={set('address')} className={inputCls} />
          </L>
          <L label="Branch name">
            <input value={f.branch_name} onChange={set('branch_name')} className={inputCls} />
          </L>
          <L label="Number of tables">
            <input type="number" min="1" value={f.table_count} onChange={set('table_count')} className={inputCls} />
          </L>
        </div>
      </fieldset>

      <p className="text-[11px] text-muted">
        After payment we&rsquo;ll build your workspace and email{' '}
        <span className="font-semibold">{f.owner_email || 'your address'}</span> a secure link to
        set your password and open your portal. Your sign-in is always your business email.
      </p>

      <label className="flex items-start gap-2 text-xs">
        <input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} className="mt-0.5" />
        <span>
          I agree to the{' '}
          <Link href="/terms-and-conditions" className="text-primary font-semibold" target="_blank">
            Terms &amp; Conditions
          </Link>{' '}
          and acknowledge the{' '}
          <Link href="/privacy-policy" className="text-primary font-semibold" target="_blank">
            Privacy Policy
          </Link>
          .
        </span>
      </label>

      {error && <p className="text-danger text-xs">{error}</p>}

      <button
        type="submit"
        disabled={busy}
        className="rounded-lg bg-primary text-primary-fg font-bold px-6 py-3 text-sm disabled:opacity-60"
      >
        {busy ? 'Processing…' : 'Continue to payment'}
      </button>
      <p className="text-[11px] text-muted">
        Payment is taken securely and your workspace is provisioned only after it&rsquo;s
        confirmed. Card details are never stored by Automation Restaurant.
      </p>
    </form>
  );
}

function L({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="text-muted text-xs font-semibold">{label}</span>
      {children}
    </label>
  );
}
