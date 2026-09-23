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

const CP_URL =
  process.env.NEXT_PUBLIC_CONTROL_PLANE_URL ||
  process.env.NEXT_PUBLIC_SUPABASE_URL ||
  'https://ckxxpyzxsbhhynlboyid.supabase.co';
const CP_ANON =
  process.env.NEXT_PUBLIC_CONTROL_PLANE_ANON_KEY ||
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNreHhweXp4c2JoaHlubGJveWlkIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc4ODk1NTQzNCwiZXhwIjoyMTA0NTMxNDM0fQ.8Pf3AAJ0MNn9LdcyWxvRARFx6EunjNWEBHj68JBKuP0';

async function fetchConfig(slug: string): Promise<TenantConfig | null> {
  const cleanSlug = slug.trim().toLowerCase();
  const candidateSlugs = [
    cleanSlug,
    cleanSlug.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, ''),
    cleanSlug.replace(/-/g, ''),
  ];
  // Remove duplicates
  const uniqueSlugs = Array.from(new Set(candidateSlugs.filter(Boolean)));

  const cols =
    'slug,restaurant_name,project_ref,project_url,anon_key,tier,subscription_status,billing_interval';

  for (const s of uniqueSlugs) {
    try {
      const res = await fetch(
        `${CP_URL}/rest/v1/tenant_directory?slug=eq.${encodeURIComponent(s)}&select=${cols}`,
        {
          headers: { apikey: CP_ANON, Authorization: `Bearer ${CP_ANON}` },
          next: { revalidate: 30 },
        },
      );
      if (!res.ok) continue;
      const rows = (await res.json()) as Record<string, string | null>[] | null;
      const row = rows?.[0];
      if (row) {
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
    } catch {
      // try next candidate
    }
  }

  // Fallback: try case-insensitive or name match if slug is slightly different
  try {
    const res = await fetch(
      `${CP_URL}/rest/v1/tenant_directory?or=(slug.ilike.*${encodeURIComponent(cleanSlug)}*,restaurant_name.ilike.*${encodeURIComponent(cleanSlug)}*)&select=${cols}`,
      {
        headers: { apikey: CP_ANON, Authorization: `Bearer ${CP_ANON}` },
        next: { revalidate: 30 },
      },
    );
    if (res.ok) {
      const rows = (await res.json()) as Record<string, string | null>[] | null;
      const row = rows?.[0];
      if (row) {
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
    }
  } catch {
    // ignore
  }

  return null;
}

/** Request-deduped tenant lookup. */
export const getTenantConfig = cache(fetchConfig);
