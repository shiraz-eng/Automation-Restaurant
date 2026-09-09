'use client';

import { createContext, useContext, useMemo } from 'react';
import { createTenantBrowserClient } from '@/lib/supabase/tenant-client';

type PortalValue = {
  slug: string;
  supabaseUrl: string;
  supabaseAnonKey: string;
};

const PortalContext = createContext<PortalValue | null>(null);

export function PortalProvider({
  value,
  children,
}: {
  value: PortalValue;
  children: React.ReactNode;
}) {
  return <PortalContext.Provider value={value}>{children}</PortalContext.Provider>;
}

export function usePortal() {
  const ctx = useContext(PortalContext);
  if (!ctx) throw new Error('usePortal must be used within <PortalProvider>');
  return ctx;
}

/** Convenience: a browser Supabase client bound to the current restaurant's project. */
export function usePortalSupabase() {
  const { supabaseUrl, supabaseAnonKey } = usePortal();
  return useMemo(
    () => createTenantBrowserClient(supabaseUrl, supabaseAnonKey),
    [supabaseUrl, supabaseAnonKey],
  );
}
