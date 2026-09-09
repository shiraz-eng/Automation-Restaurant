import { createBrowserClient } from '@supabase/ssr';

const URL = process.env.NEXT_PUBLIC_CONTROL_PLANE_URL!;
const ANON = process.env.NEXT_PUBLIC_CONTROL_PLANE_ANON_KEY!;

/** Control-plane Supabase client for Client Components (admin login / actions). */
export function createControlPlaneBrowserClient() {
  return createBrowserClient(URL, ANON);
}
