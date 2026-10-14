'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { createBrowserClient } from '@supabase/ssr';
import { createTenantBrowserClient } from '@/lib/supabase/tenant-client';
import { baseSlug, slotOf, slotSlug } from '@/lib/sessionSlot';

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
  // Never pre-fill or ship credentials in this form: it is public.
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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
      // A portal runs in its own session slot (lib/sessionSlot.ts) so it can stay open next
      // to the owner's panel. Signed in from another address (e.g. the main /login)? Move the
      // session into the portal's slot and leave this one free — no second password prompt.
      const target = slotSlug(baseSlug(slug), meta.portal_route);
      if (target !== slug && data.session) {
        const portalClient = createBrowserClient(url, anonKey, { cookieOptions: { path: `/r/${target}` } });
        await portalClient.auth.setSession({ access_token: data.session.access_token, refresh_token: data.session.refresh_token });
        // Clear this address's copy without revoking it (a sign-out would end the portal's session too).
        const ref = new URL(url).hostname.split('.')[0];
        for (const c of document.cookie.split('; ')) {
          const name = c.split('=')[0];
          if (name.startsWith(`sb-${ref}-auth-token`)) document.cookie = `${name}=; path=/r/${slug}; max-age=0; samesite=lax`;
        }
      }
      router.push(`/r/${target}/portal/${meta.portal_route}`);
    } else {
      // Every staff role uses the main portal; the dashboard sends anyone
      // without it to the first page their permissions open.
      router.push(`/r/${slug}`);
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
        <p className="text-muted mb-8">
          Staff portal · /{baseSlug(slug)}
          {slotOf(slug) && <span className="ml-1 rounded bg-primary/10 px-1.5 py-0.5 text-xs font-semibold text-primary">{slotOf(slug)} sign-in</span>}
        </p>

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
      </div>
    </div>
  );
}
