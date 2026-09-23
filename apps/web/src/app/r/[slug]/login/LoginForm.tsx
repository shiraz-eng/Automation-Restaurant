'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { createTenantBrowserClient } from '@/lib/supabase/tenant-client';
import { roleLanding } from '@/lib/portals';

export function LoginForm({
  slug,
  url,
  anonKey,
  name,
  logoUrl,
}: {
  slug: string;
  url: string;
  anonKey: string;
  name: string;
  logoUrl?: string | null;
}) {
  const router = useRouter();
  const isBbq = slug.toLowerCase().includes('bbq');
  const defaultEmail = isBbq ? 'aneelahumayoon3@gmail.com' : '';
  const [email, setEmail] = useState(defaultEmail);
  const [password, setPassword] = useState(isBbq ? 'Password123!' : '');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function fillRole(u: string, p: string = 'Password123!') {
    setEmail(u);
    setPassword(p);
    setError(null);
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);

    const supabase = createTenantBrowserClient(url, anonKey);
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });

    if (error) {
      setBusy(false);
      setError(error.message);
      return;
    }
    // No-op for a staff (non-portal) login — the RPC only writes when the
    // JWT actually carries a portal_id. Best-effort: a tracking failure
    // must never block sign-in itself.
    try {
      await supabase.rpc('portal_record_sign_in');
    } catch {
      // ignore
    }
    const meta = (data.user?.app_metadata ?? {}) as {
      role?: string;
      kind?: string;
      portal_route?: string;
    };
    if (meta.kind === 'portal' && meta.portal_route) {
      router.push(`/r/${slug}/portal/${meta.portal_route}`);
    } else {
      router.push(roleLanding(meta.role ?? 'owner', slug));
    }
    router.refresh();
  }

  return (
    <div className="min-h-screen grid place-items-center px-4">
      <div className="w-full max-w-sm">
        {logoUrl && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={logoUrl} alt={`${name} logo`} className="h-12 max-w-[12rem] object-contain mb-3" />
        )}
        <div className="font-black text-xl mb-1">{name}</div>
        <p className="text-muted mb-8">Staff portal · /{slug}</p>

        <form onSubmit={onSubmit} className="space-y-4">
          <label className="block">
            <span className="text-muted text-xs font-semibold">Email</span>
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="mt-1 w-full rounded border border-border bg-surface px-3 py-2 outline-none focus:border-primary"
            />
          </label>
          <label className="block">
            <span className="text-muted text-xs font-semibold">Password</span>
            <input
              type="password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="mt-1 w-full rounded border border-border bg-surface px-3 py-2 outline-none focus:border-primary"
            />
          </label>

          {error && <p className="text-danger text-xs">{error}</p>}

          <button
            type="submit"
            disabled={busy}
            className="w-full rounded bg-primary text-primary-fg font-semibold py-2.5 disabled:opacity-60 hover:opacity-90 transition-opacity"
          >
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
        </form>

        <div className="mt-6 pt-6 border-t border-border">
          <p className="text-xs font-semibold text-muted uppercase tracking-wider mb-2">
            Quick demo sign-in
          </p>
          <div className="grid grid-cols-2 gap-2 text-xs">
            <button
              type="button"
              onClick={() =>
                fillRole(
                  isBbq ? 'aneelahumayoon3@gmail.com' : 'owner@example.com',
                  'Password123!',
                )
              }
              className="p-2 rounded border border-border bg-surface hover:bg-surface/80 text-left font-medium transition-colors"
            >
              <div className="text-primary font-bold">Owner</div>
              <div className="text-[11px] text-muted truncate">
                {isBbq ? 'aneelahumayoon3@gmail.com' : 'Owner portal'}
              </div>
            </button>
            <button
              type="button"
              onClick={() =>
                fillRole(
                  isBbq ? 'test-manager@example.com' : 'manager@example.com',
                  'Password123!',
                )
              }
              className="p-2 rounded border border-border bg-surface hover:bg-surface/80 text-left font-medium transition-colors"
            >
              <div className="text-primary font-bold">Manager</div>
              <div className="text-[11px] text-muted truncate">
                {isBbq ? 'test-manager@example.com' : 'Management'}
              </div>
            </button>
            {isBbq && (
              <>
                <button
                  type="button"
                  onClick={() => fillRole('counter@bbq-tonight.portal', 'Password123!')}
                  className="p-2 rounded border border-border bg-surface hover:bg-surface/80 text-left font-medium transition-colors"
                >
                  <div className="text-primary font-bold">Counter POS</div>
                  <div className="text-[11px] text-muted truncate">counter@bbq-tonight</div>
                </button>
                <button
                  type="button"
                  onClick={() => fillRole('staff@bbq-tonight.portal', 'Password123!')}
                  className="p-2 rounded border border-border bg-surface hover:bg-surface/80 text-left font-medium transition-colors"
                >
                  <div className="text-primary font-bold">Staff / Attendance</div>
                  <div className="text-[11px] text-muted truncate">staff@bbq-tonight</div>
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
