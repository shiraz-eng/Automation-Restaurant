'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { createControlPlaneBrowserClient } from '@/lib/supabase/control-plane-client';

export function AdminLoginForm() {
  const router = useRouter();
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
    if ((data.user?.app_metadata as { role?: string } | undefined)?.role !== 'super_admin') {
      await supabase.auth.signOut();
      setBusy(false);
      setError('This account is not a platform administrator.');
      return;
    }
    router.push('/admin');
    router.refresh();
  }

  return (
    <div className="min-h-screen grid place-items-center px-4">
      <div className="w-full max-w-sm">
        <div className="font-black text-xl mb-1">
          Automation<span className="text-primary">.</span> Platform
        </div>
        <p className="text-muted mb-8">Super admin sign in.</p>
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
            className="w-full rounded bg-primary text-primary-fg font-semibold py-2.5 disabled:opacity-60"
          >
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
      </div>
    </div>
  );
}
