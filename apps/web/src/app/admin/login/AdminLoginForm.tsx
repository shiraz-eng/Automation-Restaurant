'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { createControlPlaneBrowserClient } from '@/lib/supabase/control-plane-client';

export function AdminLoginForm() {
  const router = useRouter();
  // Never pre-fill or ship credentials in this form: it is public and the
  // account behind it controls every restaurant on the platform.
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const supabase = createControlPlaneBrowserClient();
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) {
      setBusy(false);
      setError(error.message);
      return;
    }
    const meta = data.user?.app_metadata as { role?: string; permissions?: string[] } | undefined;
    const isPlatformAdmin =
      meta?.role === 'super_admin' || (Array.isArray(meta?.permissions) && meta.permissions.length > 0);
    if (!isPlatformAdmin) {
      await supabase.auth.signOut();
      setBusy(false);
      setError('This account is not a platform administrator.');
      return;
    }
    router.push('/admin');
    router.refresh();
  }

  return (
    <div className="min-h-screen grid place-items-center px-4 bg-ink text-ink-fg">
      <div className="w-full max-w-sm">
        <div className="font-black text-xl mb-1">
          Automation<span className="text-gold">.</span> Platform
        </div>
        <p className="text-ink-muted mb-8">Super admin sign in.</p>
        <form onSubmit={onSubmit} className="space-y-4">
          <label className="block">
            <span className="text-ink-muted text-xs font-semibold">Email</span>
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="mt-1 w-full rounded-lg border border-white/15 bg-black/30 px-3 py-2 outline-none focus:border-gold/60"
            />
          </label>
          <label className="block">
            <span className="text-ink-muted text-xs font-semibold">Password</span>
            <input
              type="password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="mt-1 w-full rounded-lg border border-white/15 bg-black/30 px-3 py-2 outline-none focus:border-gold/60"
            />
          </label>
          {error && <p className="text-red-400 text-xs">{error}</p>}
          <button
            type="submit"
            disabled={busy}
            className="w-full rounded-lg bg-gold text-ink font-semibold py-2.5 disabled:opacity-60 hover:bg-gold/90 transition-colors"
          >
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
      </div>
    </div>
  );
}
