'use client';

import { createContext, useContext, useEffect, useMemo } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createTenantBrowserClient } from '@/lib/supabase/tenant-client';

type PortalValue = {
  slug: string;
  supabaseUrl: string;
  supabaseAnonKey: string;
};

type PortalContextValue = PortalValue & { supabase: SupabaseClient };

const PortalContext = createContext<PortalContextValue | null>(null);

/**
 * Creates exactly ONE Supabase browser client for this portal's subtree and
 * shares it via context. Every descendant that needs it (nav, sign-out
 * button, the page's own client component, realtime boards, ...) must go
 * through usePortalSupabase() below rather than constructing its own client.
 *
 * This matters: @supabase/ssr's browser client runs its own background
 * auto-refresh timer and persists the session to cookies. Two independent
 * client instances in the same tab ("multiple GoTrueClient instances") race
 * that refresh — one rotates the refresh token, the other's in-flight
 * refresh then uses the now-stale token, fails, and signs the session out
 * from under the first. That race is what was causing portals to sign
 * users out a few seconds after login even though the session was fine.
 */
export function PortalProvider({
  value,
  expectedUserId,
  children,
}: {
  value: PortalValue;
  /** The user this page was rendered for. The session lives in one cookie per
   *  restaurant, shared by every tab — signing a portal login in on another
   *  tab silently swaps the identity under an already-open Owner page, whose
   *  next action then runs as the portal (and is refused). When the session
   *  user stops matching, reload so the server re-renders for whoever is
   *  actually signed in now. */
  expectedUserId?: string;
  children: React.ReactNode;
}) {
  const supabase = useMemo(
    () => createTenantBrowserClient(value.supabaseUrl, value.supabaseAnonKey),
    [value.supabaseUrl, value.supabaseAnonKey],
  );
  const ctx = useMemo(() => ({ ...value, supabase }), [value, supabase]);

  useEffect(() => {
    if (!expectedUserId) return;
    let reloading = false;
    const check = async () => {
      if (reloading || document.visibilityState === 'hidden') return;
      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (session && session.user.id !== expectedUserId) {
        reloading = true;
        window.location.reload();
      }
    };
    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      if (session && session.user.id !== expectedUserId && !reloading) {
        reloading = true;
        window.location.reload();
      }
    });
    window.addEventListener('focus', check);
    document.addEventListener('visibilitychange', check);
    return () => {
      sub.subscription.unsubscribe();
      window.removeEventListener('focus', check);
      document.removeEventListener('visibilitychange', check);
    };
  }, [supabase, expectedUserId]);
  return <PortalContext.Provider value={ctx}>{children}</PortalContext.Provider>;
}

export function usePortal() {
  const ctx = useContext(PortalContext);
  if (!ctx) throw new Error('usePortal must be used within <PortalProvider>');
  return ctx;
}

/** The single browser Supabase client shared across this portal's component tree. */
export function usePortalSupabase(): SupabaseClient {
  return usePortal().supabase;
}
