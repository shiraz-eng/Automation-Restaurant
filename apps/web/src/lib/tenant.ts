import { cache } from 'react';

/**
 * Resolves a restaurant slug to its dedicated Supabase project + plan, by
 * reading the control-plane `tenant_directory` view (public, anon-readable).
 */

export type TenantConfig = {
  slug: string;
  restaurantName: string;
  projectRef: string;
  url: string;
  anonKey: string;
  tier: string | null;
  subscriptionStatus: string | null;
  billingInterval: string | null;
};

const CP_URL = process.env.NEXT_PUBLIC_CONTROL_PLANE_URL!;
const CP_ANON = process.env.NEXT_PUBLIC_CONTROL_PLANE_ANON_KEY!;

async function fetchConfig(slug: string): Promise<TenantConfig | null> {
  const cols =
    'slug,restaurant_name,project_ref,project_url,anon_key,tier,subscription_status,billing_interval';
  const res = await fetch(
    `${CP_URL}/rest/v1/tenant_directory?slug=eq.${encodeURIComponent(slug)}&select=${cols}`,
    {
      headers: { apikey: CP_ANON, Authorization: `Bearer ${CP_ANON}` },
      next: { revalidate: 30 },
    },
  );
  if (!res.ok) return null;
  const rows = (await res.json()) as Record<string, string | null>[] | null;
  const row = rows?.[0];
  if (!row) return null;
  return {
    slug: row.slug as string,
    restaurantName: (row.restaurant_name as string) ?? 'Restaurant',
    projectRef: row.project_ref as string,
    url: row.project_url as string,
    anonKey: row.anon_key as string,
    tier: row.tier,
    subscriptionStatus: row.subscription_status,
    billingInterval: row.billing_interval,
  };
}

/** Request-deduped tenant lookup. */
export const getTenantConfig = cache(fetchConfig);
