'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';

const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

type Intent = {
  restaurant_name: string;
  owner_email: string;
  plan: string;
  billing_interval: string;
  amount_cents: number;
};

const fieldCls =
  'mt-1 w-full rounded-lg border border-border bg-surface px-3 py-2.5 text-sm outline-none focus:border-primary';

function fmtCard(v: string) {
  const digits = v.replace(/\D/g, '').slice(0, 19);
  return digits.replace(/(.{4})/g, '$1 ').trim();
}
function fmtExp(v: string) {
  const d = v.replace(/\D/g, '').slice(0, 4);
  return d.length > 2 ? `${d.slice(0, 2)}/${d.slice(2)}` : d;
}

export function PayClient({ intent }: { intent: string | null }) {
  const router = useRouter();
  const [info, setInfo] = useState<Intent | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);

  const [number, setNumber] = useState('4242 4242 4242 4242');
  const [exp, setExp] = useState('12 / 34'.replace(/\s/g, ''));
  const [cvc, setCvc] = useState('123');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [payErr, setPayErr] = useState<string | null>(null);

  useEffect(() => {
    if (!intent) {
      setLoadErr('This checkout link is missing or invalid.');
      return;
    }
    fetch(`${API}/api/onboarding/pay/intent?i=${encodeURIComponent(intent)}`)
      .then((r) => r.json())
      .then((b) => {
        if (b.error) setLoadErr('This checkout link has expired. Please start again.');
        else setInfo(b);
      })
      .catch(() => setLoadErr('Could not load your order.'));
  }, [intent]);

  const amount = useMemo(
    () => (info ? `$${(info.amount_cents / 100).toFixed(2)}` : '—'),
    [info],
  );

  async function pay(e: React.FormEvent) {
    e.preventDefault();
    setPayErr(null);
    const [mm, yy] = exp.split('/').map((s) => s.trim());
    if (!mm || !yy) return setPayErr('Enter the card expiry as MM/YY.');
    setBusy(true);
    try {
      const res = await fetch(`${API}/api/onboarding/pay/confirm`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          intent,
          card: {
            number: number.replace(/\s/g, ''),
            exp_month: Number(mm),
            exp_year: Number(yy.length === 2 ? `20${yy}` : yy),
            cvc,
          },
        }),
      });
      const b = await res.json().catch(() => ({}));
      if (!res.ok) {
        setPayErr(b.message ?? b.error ?? 'Payment could not be processed.');
        return;
      }
      if (b.connect_url) {
        window.location.href = b.connect_url;
        return;
      }
      if (b.slug) {
        router.push(`/onboarding/${b.slug}`);
        return;
      }
      setPayErr('Unexpected response.');
    } catch {
      setPayErr('Network error. Try again.');
    } finally {
      setBusy(false);
    }
  }

  if (loadErr) {
    return (
      <div className="min-h-screen grid place-items-center px-6">
        <div className="max-w-sm text-center">
          <div className="text-3xl mb-3">⚠️</div>
          <h1 className="text-lg font-black">{loadErr}</h1>
          <a
            href="/get-started"
            className="inline-block mt-6 rounded-lg bg-primary text-primary-fg font-bold px-6 py-3 text-sm"
          >
            Start over
          </a>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen grid place-items-center px-6 py-12">
      <div className="w-full max-w-sm">
        <div className="mb-4 rounded-md bg-warn/15 text-warn text-[11px] font-semibold px-3 py-1.5 text-center">
          TEST MODE — no real charge. Card 4242 4242 4242 4242 is pre-filled.
        </div>

        <div className="rounded-xl border border-border bg-surface p-6">
          <h1 className="text-lg font-black">Payment</h1>
          {info && (
            <p className="text-muted text-xs mt-1">
              {info.restaurant_name} · {info.plan} · {info.billing_interval}
            </p>
          )}
          <div className="my-4 flex items-baseline justify-between border-y border-border py-3">
            <span className="text-muted text-sm">Total due</span>
            <span className="text-xl font-black">{amount}</span>
          </div>

          <form onSubmit={pay} className="space-y-3">
            <label className="block">
              <span className="text-muted text-xs font-semibold">Name on card</span>
              <input value={name} onChange={(e) => setName(e.target.value)} className={fieldCls} />
            </label>
            <label className="block">
              <span className="text-muted text-xs font-semibold">Card number</span>
              <input
                inputMode="numeric"
                value={number}
                onChange={(e) => setNumber(fmtCard(e.target.value))}
                className={`${fieldCls} font-mono tracking-wider`}
              />
            </label>
            <div className="grid grid-cols-2 gap-3">
              <label className="block">
                <span className="text-muted text-xs font-semibold">Expiry (MM/YY)</span>
                <input
                  inputMode="numeric"
                  value={exp}
                  onChange={(e) => setExp(fmtExp(e.target.value))}
                  placeholder="MM/YY"
                  className={`${fieldCls} font-mono`}
                />
              </label>
              <label className="block">
                <span className="text-muted text-xs font-semibold">CVC</span>
                <input
                  inputMode="numeric"
                  value={cvc}
                  onChange={(e) => setCvc(e.target.value.replace(/\D/g, '').slice(0, 4))}
                  className={`${fieldCls} font-mono`}
                />
              </label>
            </div>

            {payErr && <p className="text-danger text-xs">{payErr}</p>}

            <button
              type="submit"
              disabled={busy || !info}
              className="w-full rounded-lg bg-primary text-primary-fg font-bold py-3 text-sm disabled:opacity-60"
            >
              {busy ? 'Processing…' : `Pay ${amount}`}
            </button>
          </form>
        </div>
        <p className="text-[11px] text-muted mt-3 text-center">
          Card details are validated for format only and are never stored by Automation Restaurant.
        </p>
      </div>
    </div>
  );
}
