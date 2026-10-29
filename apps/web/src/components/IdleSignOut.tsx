'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { usePortalSupabase } from '@/components/PortalProvider';
import { useDialogFocus } from '@/lib/useDialogFocus';

const WARN_SECONDS = 30;
const ACTIVITY = ['pointerdown', 'keydown', 'touchstart', 'wheel'] as const;

/**
 * Signs a station login out after `minutes` with no touch, click or key press
 * (portals.idle_minutes, tenant-migrations/0111), so a shared counter or kitchen
 * tablet left alone doesn't stay signed in. A 30-second warning lets whoever is
 * there stay signed in. Sign-out is the same as the Sign out button's.
 */
export function IdleSignOut({ minutes, redirectTo }: { minutes: number; redirectTo: string }) {
  const supabase = usePortalSupabase();
  const router = useRouter();
  const last = useRef(Date.now());
  const [left, setLeft] = useState<number | null>(null);
  const warning = useRef(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  useDialogFocus(dialogRef, left !== null, () => stay());

  function stay() {
    last.current = Date.now();
    warning.current = false;
    setLeft(null);
  }

  useEffect(() => {
    const limit = minutes * 60_000;
    const onActivity = () => {
      // While the warning is up, only its button keeps the session (a stray touch elsewhere doesn't).
      if (!warning.current) last.current = Date.now();
    };
    ACTIVITY.forEach((e) => window.addEventListener(e, onActivity, { passive: true }));
    const timer = window.setInterval(async () => {
      const idle = Date.now() - last.current;
      if (idle >= limit) {
        window.clearInterval(timer);
        try {
          await supabase.rpc('portal_record_sign_out');
        } catch {
          // best-effort, never blocks signing out
        }
        await supabase.auth.signOut();
        router.push(redirectTo);
        router.refresh();
      } else if (idle >= limit - WARN_SECONDS * 1000) {
        warning.current = true;
        setLeft(Math.ceil((limit - idle) / 1000));
      }
    }, 1000);
    return () => {
      ACTIVITY.forEach((e) => window.removeEventListener(e, onActivity));
      window.clearInterval(timer);
    };
  }, [minutes, redirectTo, supabase, router]);

  if (left === null) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div ref={dialogRef} role="alertdialog" aria-modal="true" aria-labelledby="idle-title" aria-describedby="idle-text" className="w-full max-w-sm rounded-lg border border-border bg-surface p-6 text-center">
        <h2 id="idle-title" className="text-lg font-black">Still there?</h2>
        <p id="idle-text" className="mt-2 text-sm text-muted">
          This station signs out in <span className="font-bold text-body">{left}</span> seconds because nobody has used it.
        </p>
        <button type="button" onClick={stay} className="mt-5 min-h-12 w-full rounded bg-primary px-4 text-sm font-bold text-primary-fg">
          Stay signed in
        </button>
      </div>
    </div>
  );
}
