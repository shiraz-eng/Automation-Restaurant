'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';

const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

export function PendingClient({ checkoutSessionId }: { checkoutSessionId: string | null }) {
  const router = useRouter();
  const [phase, setPhase] = useState<'confirming' | 'building' | 'stuck'>('confirming');
  const [waited, setWaited] = useState(0);

  useEffect(() => {
    if (!checkoutSessionId) return;
    let alive = true;
    const poll = async () => {
      try {
        const res = await fetch(
          `${API}/api/onboarding/session/${encodeURIComponent(checkoutSessionId)}`,
        );
        if (!res.ok) return;
        const b = await res.json();
        if (!alive) return;
        if (b.slug) {
          // The webhook has created the tenant — hand off to the status screen.
          router.replace(`/onboarding/${b.slug}`);
          return;
        }
        if (b.paid) setPhase('building');
      } catch {
        /* keep polling */
      }
    };
    poll();
    const id = setInterval(poll, 2500);
    const clock = setInterval(() => setWaited((s) => s + 1), 1000);
    return () => {
      alive = false;
      clearInterval(id);
      clearInterval(clock);
    };
  }, [checkoutSessionId, router]);

  useEffect(() => {
    if (waited > 90 && phase !== 'stuck') setPhase('stuck');
  }, [waited, phase]);

  return (
    <div className="min-h-screen grid place-items-center px-6">
      <div className="w-full max-w-md text-center">
        {!checkoutSessionId ? (
          <>
            <h1 className="text-lg font-black">Nothing to confirm</h1>
            <p className="text-muted text-sm mt-2">This page is shown right after checkout.</p>
            <Link
              href="/get-started"
              className="inline-block mt-6 rounded-lg bg-primary text-primary-fg font-bold px-6 py-3 text-sm"
            >
              Start over
            </Link>
          </>
        ) : phase === 'stuck' ? (
          <>
            <div className="text-3xl mb-3">📨</div>
            <h1 className="text-lg font-black">Your payment is confirmed</h1>
            <p className="text-muted text-sm mt-2">
              We&rsquo;re still setting up your workspace. You can close this page — we&rsquo;ll
              email your portal link the moment it&rsquo;s ready.
            </p>
          </>
        ) : (
          <>
            <div className="mx-auto w-8 h-8 border-4 border-primary border-t-transparent rounded-full animate-spin mb-4" />
            <h1 className="text-lg font-black">
              {phase === 'confirming' ? 'Confirming your payment…' : 'Payment confirmed — building your workspace…'}
            </h1>
            <p className="text-muted text-xs mt-2">
              This only takes a moment. Keep this page open.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
