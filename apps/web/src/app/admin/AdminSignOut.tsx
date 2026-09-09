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
      className="rounded border border-border px-3 py-1.5 text-xs font-semibold hover:bg-main"
    >
      Sign out
    </button>
  );
}
