'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { usePortalSupabase } from '@/components/PortalProvider';

/**
 * Invisible: subscribes to postgres_changes on the given tables and calls
 * router.refresh() on any change, so a payment taken at one counter (or any
 * other portal) shows up here without a manual reload. The refresh re-runs
 * the Server Component's own query — authoritative server state always
 * wins over whatever the realtime payload said, it's only a "go look again"
 * signal, never trusted as the actual new value.
 */
export function LiveRefresh({ tables, channel }: { tables: string[]; channel: string }) {
  const router = useRouter();
  const supabase = usePortalSupabase();
  const key = tables.join(',');

  useEffect(() => {
    let ch = supabase.channel(channel);
    for (const table of key.split(',')) {
      ch = ch.on('postgres_changes', { event: '*', schema: 'public', table }, () => router.refresh());
    }
    ch.subscribe();
    return () => {
      supabase.removeChannel(ch);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [supabase, channel, key]);

  return null;
}
