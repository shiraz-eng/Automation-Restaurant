'use client';

import { createContext, useContext, useMemo } from 'react';
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
  children,
}: {
  value: PortalValue;
  children: React.ReactNode;
}) {
  const supabase = useMemo(
    () => createTenantBrowserClient(value.supabaseUrl, value.supabaseAnonKey),
    [value.supabaseUrl, value.supabaseAnonKey],
  );
  const ctx = useMemo(() => ({ ...value, supabase }), [value, supabase]);
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
