import { createBrowserClient } from '@supabase/ssr';

// Public by design (RLS enforces access) — never fall back to a
// service_role key here. This client ships to the browser and is used by
// every admin-panel client component; a service_role fallback would put a
// bypass-RLS client directly into visitor-facing JS.
function requireEnv(value: string | undefined, name: string): string {
  if (!value) throw new Error(`Missing ${name} — set it in the deployment environment.`);
  return value;
}
const URL = requireEnv(
  process.env.NEXT_PUBLIC_CONTROL_PLANE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL,
  'NEXT_PUBLIC_CONTROL_PLANE_URL',
);
const ANON = requireEnv(
  process.env.NEXT_PUBLIC_CONTROL_PLANE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  'NEXT_PUBLIC_CONTROL_PLANE_ANON_KEY',
);

/** Control-plane Supabase client for Client Components (admin login / actions). */
export function createControlPlaneBrowserClient() {
  return createBrowserClient(URL, ANON);
}
