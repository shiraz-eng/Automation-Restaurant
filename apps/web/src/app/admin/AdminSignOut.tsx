'use client';

import { useRouter } from 'next/navigation';
import { createControlPlaneBrowserClient } from '@/lib/supabase/control-plane-client';

export function AdminSignOut() {
  const router = useRouter();
  async function signOut() {
    await createControlPlaneBrowserClient().auth.signOut();
    router.push('/admin/login');
    router.refresh();
  }
  return (
    <button
      onClick={signOut}
      className="rounded-lg border border-white/15 text-ink-fg px-3 py-1.5 text-xs font-semibold hover:bg-white/5 shrink-0"
    >
      Sign out
    </button>
  );
}
