import { createBrowserClient } from '@supabase/ssr';

const URL =
  process.env.NEXT_PUBLIC_CONTROL_PLANE_URL ||
  process.env.NEXT_PUBLIC_SUPABASE_URL ||
  'https://ckxxpyzxsbhhynlboyid.supabase.co';
const ANON =
  process.env.NEXT_PUBLIC_CONTROL_PLANE_ANON_KEY ||
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNreHhweXp4c2JoaHlubGJveWlkIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc4ODk1NTQzNCwiZXhwIjoyMTA0NTMxNDM0fQ.8Pf3AAJ0MNn9LdcyWxvRARFx6EunjNWEBHj68JBKuP0';

/** Control-plane Supabase client for Client Components (admin login / actions). */
export function createControlPlaneBrowserClient() {
  return createBrowserClient(URL, ANON);
}
