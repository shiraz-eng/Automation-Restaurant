import { getTenantConfig } from '@/lib/tenant';
import type { BrandKit } from '@/lib/theme';
import { createClient } from '@supabase/supabase-js';
import {
  StorefrontClient,
  type MenuItem,
  type MenuCategory,
  type DealLite,
} from './StorefrontClient';

export const dynamic = 'force-dynamic';

const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

async function getMenu(slug: string, config?: { url: string; anonKey: string } | null) {
  try {
    const res = await fetch(`${API}/api/public/menu/${encodeURIComponent(slug)}`, {
      cache: 'no-store',
    });
    if (res.ok) {
      return (await res.json()) as {
        categories: MenuCategory[];
        items: MenuItem[];
        deals?: DealLite[];
        brandKit?: BrandKit | null;
      };
    }
  } catch {
    // API server may not be running locally; fall back to direct Supabase tenant query
  }

  if (!config) return null;

  try {
    const client = createClient(config.url, config.anonKey);
    const [{ data: categories }, { data: items }, { data: deals }, { data: brandKitRows }] =
      await Promise.all([
        client.from('menu_categories').select('id, name, sort_order').order('sort_order'),
        client.from('menu_items').select('*').eq('is_available', true),
        client.from('deals').select('*').eq('is_active', true),
        client.rpc('get_brand_kit'),
      ]);

    const brandKit = (Array.isArray(brandKitRows) ? brandKitRows[0] : brandKitRows) as BrandKit | null;

    return {
      categories: (categories ?? []) as MenuCategory[],
      items: (items ?? []) as MenuItem[],
      deals: (deals ?? []) as DealLite[],
      brandKit: brandKit ?? null,
    };
  } catch (err) {
    console.error('Failed to load menu directly:', err);
    return null;
  }
}

export default async function OrderPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ table?: string }>;
}) {
  const { slug } = await params;
  const { table } = await searchParams;
  const config = await getTenantConfig(slug);
  const menu = await getMenu(slug, config);

  if (!config || !menu) {
    return (
      <div className="min-h-screen grid place-items-center px-6 text-center">
        <p className="text-muted text-sm">
          Couldn&apos;t load this menu. Check the link or try again.
        </p>
      </div>
    );
  }

  return (
    <StorefrontClient
      slug={slug}
      restaurantName={config.restaurantName}
      table={table ?? null}
      categories={menu.categories}
      items={menu.items}
      deals={menu.deals ?? []}
      brandKit={menu.brandKit ?? null}
    />
  );
}
