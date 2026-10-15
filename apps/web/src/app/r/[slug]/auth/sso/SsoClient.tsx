'use client';

import { useEffect, useState } from 'react';
import { createTenantBrowserClient } from '@/lib/supabase/tenant-client';

export function SsoClient({ slug, url, anonKey, name }: { slug: string; url: string; anonKey: string; name: string }) {
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const token = new URLSearchParams(window.location.hash.slice(1)).get('t');
    // Drop the token from the address straight away (history, screenshots).
    window.history.replaceState(null, '', window.location.pathname);
    if (!token) {
      setError('This sign-in link is incomplete. Open the branch again from your owner panel.');
      return;
    }
    const supabase = createTenantBrowserClient(url, anonKey);
    void supabase.auth.verifyOtp({ token_hash: token, type: 'magiclink' }).then(({ error: e }) => {
      if (e) {
        setError('This sign-in link has expired or was already used. Open the branch again from your owner panel.');
        return;
      }
      window.location.replace(`/r/${slug}`);
    });
  }, [slug, url, anonKey]);

  return (
    <div className="min-h-screen grid place-items-center px-4">
      <div className="w-full max-w-sm text-center space-y-3">
        <div className="font-black text-xl">{name}</div>
        {error ? (
          <>
            <p className="text-danger text-sm">{error}</p>
            <a href={`/r/${slug}/login`} className="text-primary text-sm underline">
              Sign in with a password instead
            </a>
          </>
        ) : (
          <p className="text-muted text-sm">Opening the branch workspace…</p>
        )}
      </div>
    </div>
  );
}
