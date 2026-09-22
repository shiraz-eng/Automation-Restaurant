'use client';

import { useRouter } from 'next/navigation';
import { usePortalSupabase } from '@/components/PortalProvider';

export function SignOutButton({ redirectTo }: { redirectTo: string }) {
  const router = useRouter();
  const supabase = usePortalSupabase();

  async function signOut() {
    // Must run while still authenticated — the RPC reads the portal id off
    // the current JWT. No-op for a staff (non-portal) login. Best-effort:
    // a tracking failure must never block signing out.
    try {
      await supabase.rpc('portal_record_sign_out');
    } catch {
      // ignore
    }
    await supabase.auth.signOut();
    router.push(redirectTo);
    router.refresh();
  }

  return (
    <button
      onClick={signOut}
      className="rounded border border-border px-3 py-1.5 text-xs font-semibold hover:bg-main"
    >
      Sign out
    </button>
  );
}
