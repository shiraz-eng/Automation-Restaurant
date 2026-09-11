'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { createTenantBrowserClient } from '@/lib/supabase/tenant-client';

export function SetPortalPasswordForm({
  slug,
  portalKey,
  url,
  anonKey,
  name,
}: {
  slug: string;
  portalKey: string;
  url: string;
  anonKey: string;
  name: string;
}) {
  const router = useRouter();
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (pw.length < 8) return setError('Use at least 8 characters.');
    if (pw !== pw2) return setError('The passwords don’t match.');
    setBusy(true);
    setError(null);
    const supabase = createTenantBrowserClient(url, anonKey);
    const { error: e1 } = await supabase.auth.updateUser({ password: pw });
    if (e1) {
      setBusy(false);
      setError(e1.message);
      return;
    }
    await supabase.rpc('clear_force_pw_change');
    router.push(portalKey ? `/r/${slug}/portal/${portalKey}` : `/r/${slug}/login`);
    router.refresh();
  }

  return (
    <div className="min-h-screen grid place-items-center px-4">
      <div className="w-full max-w-sm">
        <div className="font-black text-xl mb-1">{name}</div>
        <p className="text-muted mb-8">Choose a password for this portal before continuing.</p>
        <form onSubmit={submit} className="space-y-4">
          <label className="block">
            <span className="text-muted text-xs font-semibold">New password</span>
            <input
              type="password"
              required
              value={pw}
              onChange={(e) => setPw(e.target.value)}
              className="mt-1 w-full rounded border border-border bg-surface px-3 py-2 outline-none focus:border-primary"
            />
          </label>
          <label className="block">
            <span className="text-muted text-xs font-semibold">Confirm password</span>
            <input
              type="password"
              required
              value={pw2}
              onChange={(e) => setPw2(e.target.value)}
              className="mt-1 w-full rounded border border-border bg-surface px-3 py-2 outline-none focus:border-primary"
            />
          </label>
          {error && <p className="text-danger text-xs">{error}</p>}
          <button
            type="submit"
            disabled={busy}
            className="w-full rounded bg-primary text-primary-fg font-semibold py-2.5 disabled:opacity-60"
          >
            {busy ? 'Saving…' : 'Set password'}
          </button>
        </form>
      </div>
    </div>
  );
}
