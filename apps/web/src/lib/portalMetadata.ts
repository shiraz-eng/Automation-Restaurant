import type { Metadata } from 'next';
import { createTenantServerClient } from './supabase/tenant-server';
import type { BrandKit } from './theme';

/**
 * One restaurant's portal identity (browser <title> + favicon), read
 * through the SAME get_brand_kit() RPC every other Brand Kit consumer
 * uses — not a second "portal identity" fetch. Both the staff portal
 * layout and the kiosk portal layout call this, so a restaurant's title/
 * favicon is defined exactly once and every sub-page inherits it via
 * Next.js's own title-template mechanism: a sub-page that sets its own
 * plain-string `metadata.title` (e.g. 'Kitchen') gets wrapped by this
 * layout's template into "Kitchen — <restaurant>"; a page with no title
 * of its own just shows the restaurant identity verbatim.
 */
export async function buildPortalMetadata(slug: string): Promise<Metadata> {
  const t = await createTenantServerClient(slug);
  if (!t) return { title: 'Automation Restaurant' };

  const { data: rows } = await t.client.rpc('get_brand_kit');
  const kit = (Array.isArray(rows) ? rows[0] : rows) as BrandKit | null;
  const identity = kit?.meta_title?.trim() || t.config.restaurantName;

  return {
    title: { default: identity, template: `${identity} — %s` },
    ...(kit?.logo_url ? { icons: { icon: kit.logo_url } } : {}),
  };
}
