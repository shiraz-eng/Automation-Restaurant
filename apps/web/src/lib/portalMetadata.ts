import type { Metadata } from 'next';
import { createClient } from '@supabase/supabase-js';
import { createTenantServerClient } from './supabase/tenant-server';
import { getTenantConfig } from './tenant';
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

/**
 * Customer storefront identity (browser <title>, favicon, meta tags, og tags)
 * for /order/[slug] and /order/[slug]/track/[orderId].
 */
export async function buildOrderMetadata(slug: string): Promise<Metadata> {
  const config = await getTenantConfig(slug);
  if (!config) return { title: 'Order Online — Automation Restaurant' };

  let kit: BrandKit | null = null;
  try {
    const client = createClient(config.url, config.anonKey);
    const { data: rows } = await client.rpc('get_brand_kit');
    kit = (Array.isArray(rows) ? rows[0] : rows) as BrandKit | null;
  } catch {
    /* fallback to tenant config */
  }

  const identity = kit?.meta_title?.trim() || config.restaurantName;
  const description = `Order online from ${identity}. View menu, deals, and order fresh food.`;

  return {
    title: { default: `${identity} — Order Online`, template: `%s — ${identity}` },
    description,
    openGraph: {
      title: `${identity} — Order Online`,
      description,
      ...(kit?.logo_url ? { images: [{ url: kit.logo_url }] } : {}),
    },
    ...(kit?.logo_url ? { icons: { icon: kit.logo_url } } : {}),
  };
}
