import { cache } from 'react';
import { baseSlug } from './sessionSlot';

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
  /** An independent branch (control-plane 0025): the owner's main restaurant, and the branch code. */
  parentSlug: string | null;
  branchCode: string | null;
};

// Public by design (RLS enforces access) — never fall back to a service_role
// key here, this resolves tenant config for every public order/portal page.
const CP_URL = process.env.NEXT_PUBLIC_CONTROL_PLANE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '';
const CP_ANON = process.env.NEXT_PUBLIC_CONTROL_PLANE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '';

// EXACT slug match only. There used to be a fuzzy fallback (slug or name
// "contains" the text), which could open ANOTHER restaurant's database —
// e.g. /r/bbq-night (a sign-up that never got a database) silently loaded
// bbq-night-c0fdb, while the API (exact match) said "not found". A slug
// identifies exactly one restaurant; anything else is "not found".
async function fetchConfig(slug: string): Promise<TenantConfig | null> {
  // A session slot (/r/<slug>~<slot>, lib/sessionSlot.ts) is the same restaurant.
  const cleanSlug = baseSlug(slug).trim().toLowerCase();
  const candidateSlugs = [cleanSlug, cleanSlug.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')];
  // Remove duplicates
  const uniqueSlugs = Array.from(new Set(candidateSlugs.filter(Boolean)));

  const base = 'slug,restaurant_name,project_ref,project_url,anon_key,tier,subscription_status,billing_interval';
  // parent_slug/branch_code arrive with control-plane 0025; before it, read the base columns.
  const colSets = [`${base},parent_slug,branch_code`, base];

  for (const s of uniqueSlugs) for (const cols of colSets) {
    try {
      const res = await fetch(
        `${CP_URL}/rest/v1/tenant_directory?slug=eq.${encodeURIComponent(s)}&select=${cols}`,
        {
          headers: { apikey: CP_ANON, Authorization: `Bearer ${CP_ANON}` },
          next: { revalidate: 30 },
        },
      );
      if (res.status === 400) continue; // a column this control plane doesn't have yet
      if (!res.ok) break;
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
          parentSlug: (row.parent_slug as string | null | undefined) ?? null,
          branchCode: (row.branch_code as string | null | undefined) ?? null,
        };
      }
    } catch {
      // try next candidate
    }
    break; // this slug answered (found nothing): next candidate
  }

  return null;
}

/** Request-deduped tenant lookup. */
export const getTenantConfig = cache(fetchConfig);
