'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';

const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

const STEPS = [
  'Payment confirmed',
  'Restaurant workspace created',
  'Database configured',
  'Roles configured',
  'Default settings created',
  'Portal ready',
];

type Status = 'awaiting_connection' | 'provisioning' | 'active' | 'failed';

export function OnboardingStatus({ slug }: { slug: string }) {
  const [status, setStatus] = useState<Status>('provisioning');
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState<string | null>(null);
  const [connectUrl, setConnectUrl] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);

  // Surface ?connect=denied / ?connect=error handed back by the OAuth callback.
  const [connectNote, setConnectNote] = useState<string | null>(null);
  useEffect(() => {
    const q = new URLSearchParams(window.location.search).get('connect');
    if (q === 'denied') setConnectNote('Authorization was cancelled. You can try again below.');
    else if (q === 'error')
      setConnectNote('Something went wrong connecting Supabase. Please try again.');
  }, []);

  useEffect(() => {
    let alive = true;
    const poll = async () => {
      try {
        const res = await fetch(`${API}/api/onboarding/status/${encodeURIComponent(slug)}`);
        if (!res.ok) return;
        const body = await res.json();
        if (!alive) return;
        setName(body.restaurant_name ?? null);
        setConnectUrl(body.connect_url ?? null);
        if (body.status === 'active') setStatus('active');
        else if (body.status === 'failed') {
          setStatus('failed');
          setError(body.error ?? 'Provisioning failed.');
        } else if (body.status === 'awaiting_connection') {
          setStatus('awaiting_connection');
        } else {
          setStatus('provisioning');
        }
      } catch {
        /* keep polling */
      }
    };
    poll();
    const id = setInterval(poll, 2500);
    const clock = setInterval(() => setElapsed((s) => s + 1), 1000);
    return () => {
      alive = false;
      clearInterval(id);
      clearInterval(clock);
    };
  }, [slug]);

  // Reveal the checklist gradually while provisioning; all done when active.
  const revealed =
    status === 'active' ? STEPS.length : Math.min(STEPS.length - 1, 1 + Math.floor(elapsed / 12));

  return (
    <div className="min-h-screen grid place-items-center px-6">
      <div className="w-full max-w-md">
        {status === 'awaiting_connection' ? (
          <>
            <div className="text-3xl mb-3">🔌</div>
            <h1 className="text-lg font-black">Connect your Supabase account</h1>
            <p className="text-muted text-sm mt-2">
              {name ?? 'Your restaurant'} gets its own dedicated database, created inside{' '}
              <span className="font-semibold">your</span> Supabase organization. Click below to
              sign in to Supabase and authorize access — it takes about a minute.
            </p>
            <ol className="mt-4 space-y-1.5 text-xs text-muted list-decimal list-inside">
              <li>Sign in to Supabase (or create a free account)</li>
              <li>Pick the organization to use</li>
              <li>Approve access — we create the project for you</li>
            </ol>
            {connectNote && (
              <p className="text-danger text-xs mt-3">{connectNote}</p>
            )}
            {connectUrl ? (
              <a
                href={connectUrl}
                className="inline-block mt-6 rounded-lg bg-primary text-primary-fg font-bold px-6 py-3 text-sm"
              >
                Connect Supabase
              </a>
            ) : (
              <p className="text-muted text-xs mt-6">Preparing…</p>
            )}
          </>
        ) : status === 'failed' ? (
          <>
            <div className="text-3xl mb-3">⚠️</div>
            <h1 className="text-lg font-black">
              Something went wrong setting up {name ?? 'your restaurant'}
            </h1>
            <p className="text-muted text-sm mt-2">
              Our team has been alerted. Please contact support with your restaurant name.
            </p>
            {error && (
              <p className="text-danger text-[11px] mt-3 font-mono break-all">{error}</p>
            )}
            <Link
              href="/contact"
              className="inline-block mt-6 rounded-lg bg-primary text-primary-fg font-semibold px-5 py-2.5 text-sm"
            >
              Contact support
            </Link>
          </>
        ) : status === 'active' ? (
          <>
            <div className="text-4xl mb-3">✅</div>
            <h1 className="text-lg font-black">{name ?? 'Your restaurant'} is ready!</h1>
            <ul className="mt-5 space-y-2 text-sm">
              {STEPS.map((s) => (
                <li key={s} className="flex items-center gap-2 text-body">
                  <span className="text-ok">✓</span> {s}
                </li>
              ))}
            </ul>
            <Link
              href={`/r/${slug}/login`}
              className="inline-block mt-6 rounded-lg bg-primary text-primary-fg font-bold px-6 py-3 text-sm"
            >
              Open Restaurant Portal
            </Link>
          </>
        ) : (
          <>
            <div className="w-8 h-8 border-4 border-primary border-t-transparent rounded-full animate-spin mb-4" />
            <h1 className="text-lg font-black">Setting up {name ?? 'your restaurant'}…</h1>
            <p className="text-muted text-xs mt-1">
              This takes a couple of minutes — a dedicated database is being created. You can
              keep this page open.
            </p>
            <ul className="mt-5 space-y-2 text-sm">
              {STEPS.map((s, i) => (
                <li
                  key={s}
                  className={`flex items-center gap-2 ${i < revealed ? 'text-body' : 'text-muted'}`}
                >
                  <span className={i < revealed ? 'text-ok' : ''}>
                    {i < revealed ? '✓' : '○'}
                  </span>{' '}
                  {s}
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </div>
  );
}
