'use client';

import { useRouter } from 'next/navigation';
import { usePortalSupabase } from '@/components/PortalProvider';

export function SignOutButton({ redirectTo }: { redirectTo: string }) {
  const router = useRouter();
  const supabase = usePortalSupabase();

  async function signOut() {
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
