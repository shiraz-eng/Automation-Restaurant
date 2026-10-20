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
/**
 * A restaurant's own browser icon — never the Automation Restaurant robot, which is the
 * website's alone. Its Brand Kit logo when it has one; otherwise the first letter of its
 * name on its brand colour, so every portal still has an icon of its own.
 */
export function restaurantIcons(kit: BrandKit | null, name: string): NonNullable<Metadata['icons']> {
  if (kit?.logo_url) return { icon: kit.logo_url, shortcut: kit.logo_url, apple: kit.logo_url };
  // primary_color is "R G B" (Brand Kit); fall back to a neutral slate.
  const rgb = /^\d{1,3} \d{1,3} \d{1,3}$/.test(kit?.primary_color?.trim() ?? '') ? kit!.primary_color!.trim().replace(/ /g, ',') : '51,65,85';
  const letter = (name.trim().match(/[\p{L}\p{N}]/u)?.[0] ?? 'R').toUpperCase();
  const safe = letter.replace(/[<>&"']/g, '');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="rgb(${rgb})"/><text x="32" y="44" font-family="Arial,Helvetica,sans-serif" font-size="38" font-weight="700" text-anchor="middle" fill="#fff">${safe}</text></svg>`;
  const url = `data:image/svg+xml,${encodeURIComponent(svg)}`;
  return { icon: [{ url, type: 'image/svg+xml' }], shortcut: url, apple: url };
}

export async function buildPortalMetadata(slug: string): Promise<Metadata> {
  const t = await createTenantServerClient(slug);
  if (!t) return { title: 'Automation Restaurant', icons: restaurantIcons(null, 'Restaurant') };

  const { data: rows } = await t.client.rpc('get_brand_kit');
  const kit = (Array.isArray(rows) ? rows[0] : rows) as BrandKit | null;
  const identity = kit?.meta_title?.trim() || t.config.restaurantName;

  return {
    title: { default: identity, template: `${identity} — %s` },
    icons: restaurantIcons(kit, identity),
  };
}

/**
 * Customer storefront identity (browser <title>, favicon, meta tags, og tags)
 * for /order/[slug] and /order/[slug]/track/[orderId]. Follows the restaurant's
 * Brand Kit (meta title, custom logo favicon, theme) exactly like the staff portal.
 */
export async function buildOrderMetadata(slug: string): Promise<Metadata> {
  const config = await getTenantConfig(slug);
  if (!config) return { title: 'Automation Restaurant', icons: restaurantIcons(null, 'Restaurant') };

  let kit: BrandKit | null = null;
  try {
    const client = createClient(config.url, config.anonKey, {
      auth: { persistSession: false },
    });
    const { data: rows } = await client.rpc('get_brand_kit');
    kit = (Array.isArray(rows) ? rows[0] : rows) as BrandKit | null;
  } catch {
    /* fallback to tenant config */
  }

  const identity = kit?.meta_title?.trim() || config.restaurantName;
  const description = `Order online from ${identity}. View menu, deals, and order fresh food.`;

  return {
    title: { default: identity, template: `%s — ${identity}` },
    description,
    openGraph: {
      title: identity,
      description,
      ...(kit?.logo_url ? { images: [{ url: kit.logo_url }] } : {}),
    },
    icons: restaurantIcons(kit, identity),
  };
}
