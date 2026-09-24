'use client';

import { useState } from 'react';
import { usePortalSupabase } from '@/components/PortalProvider';

/** Self-service password change for the person signed in to their own
 *  account — auth.updateUser() acts on the caller's own active session,
 *  so no admin API / service-role / backend route is needed, and it's
 *  inherently scoped: a session can only ever update itself. Distinct
 *  from Portal Management's "Reset password" (an Owner resetting a
 *  KIOSK portal's login on its behalf, via the Admin API). */
export function ChangePasswordControl() {
  const supabase = usePortalSupabase();
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  function close() {
    setOpen(false);
    setPassword('');
    setConfirm('');
    setError(null);
    setDone(false);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (password.length < 8) {
      setError('Password must be at least 8 characters.');
      return;
    }
    if (password !== confirm) {
      setError("Passwords don't match.");
      return;
    }
    setBusy(true);
    try {
      const { error: upErr } = await supabase.auth.updateUser({ password });
      if (upErr) {
        setError(upErr.message);
        return;
      }
      setDone(true);
      setPassword('');
      setConfirm('');
    } catch {
      setError('Network error — try again.');
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="text-left text-[11px] text-muted hover:text-body hover:underline"
      >
        Change password
      </button>
    );
  }

  return (
    <form onSubmit={submit} className="space-y-2 rounded border border-border bg-main p-3">
      {done ? (
        <>
          <p className="text-ok text-[11px]">Password updated.</p>
          <button type="button" onClick={close} className="text-[11px] font-semibold text-primary hover:underline">
            Close
          </button>
        </>
      ) : (
        <>
          <input
            type="password"
            required
            placeholder="New password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="w-full rounded border border-border bg-surface px-2 py-1.5 text-xs outline-none focus:border-primary"
          />
          <input
            type="password"
            required
            placeholder="Confirm new password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            className="w-full rounded border border-border bg-surface px-2 py-1.5 text-xs outline-none focus:border-primary"
          />
          {error && <p className="text-danger text-[11px]">{error}</p>}
          <div className="flex gap-2">
            <button
              type="submit"
              disabled={busy}
              className="rounded bg-primary text-primary-fg px-2.5 py-1 text-[11px] font-semibold disabled:opacity-60"
            >
              {busy ? 'Saving…' : 'Save'}
            </button>
            <button type="button" onClick={close} className="text-[11px] text-muted hover:text-body">
              Cancel
            </button>
          </div>
        </>
      )}
    </form>
  );
}
