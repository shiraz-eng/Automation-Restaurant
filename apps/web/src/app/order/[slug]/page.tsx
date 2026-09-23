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

const MENU_ITEM_SELECT =
  'id, name, description, price_cents, category_id, image_url, menu_variants(id, name, price_cents, sku, is_available, track_availability, available_qty, sort_order), modifier_groups(id, name, kind, min_select, max_select, sort_order, modifier_options(id, name, price_cents, is_available, sort_order))';
const DEAL_SELECT =
  'id, name, description, image_url, price_cents, sort_order, deal_components(qty, menu_item_id, variant_id, menu_items(name, price_cents, menu_variants(price_cents, sort_order)), menu_variants(name, price_cents)), deal_option_groups(id, name, min_select, max_select, sort_order, deal_option_items(id, menu_item_id, variant_id, qty, price_adjustment_cents, is_default, sort_order, menu_items(name, is_available), menu_variants(name, is_available, track_availability, available_qty)))';

async function getMenu(slug: string, config?: { url: string; anonKey: string } | null) {
  if (API && !API.includes('localhost:4000')) {
    try {
      const res = await fetch(`${API}/api/public/menu/${encodeURIComponent(slug)}`, {
        cache: 'no-store',
        signal: AbortSignal.timeout(4000),
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
      // Fall through to direct Supabase tenant query
    }
  }

  if (!config) return null;

  try {
    const client = createClient(config.url, config.anonKey);
    const [{ data: categories }, { data: items }, { data: deals }, { data: brandKitRows }] =
      await Promise.all([
        client.from('menu_categories').select('id, name, sort_order').order('sort_order'),
        // Same nested select the Express endpoint uses (apps/api/src/routes/public.ts)
        // — a flat select('*') here silently produced items with no
        // menu_variants, which toBrowseItems() then filters out entirely,
        // making the whole menu look empty despite real data existing.
        client.from('menu_items').select(MENU_ITEM_SELECT).eq('is_available', true).order('name'),
        client.from('deals').select(DEAL_SELECT).eq('is_available', true).order('sort_order'),
        client.rpc('get_brand_kit'),
      ]);

    const brandKit = (Array.isArray(brandKitRows) ? brandKitRows[0] : brandKitRows) as BrandKit | null;

    // Same manual-toggle filtering the Express endpoint applies (minus its
    // recipe-driven computed_available layer, which needs the tenant's
    // product_availability table — acceptable to omit here since an item
    // missing that flag just always shows as available, never vanishes).
    const cleanedItems = ((items ?? []) as Record<string, unknown>[]).map((it) => ({
      ...it,
      menu_variants: ((it.menu_variants as Record<string, unknown>[] | null) ?? [])
        .filter((v) => v.is_available && (!v.track_availability || ((v.available_qty as number) ?? 0) > 0))
        .sort((a, b) => (a.sort_order as number) - (b.sort_order as number)),
      modifier_groups: ((it.modifier_groups as Record<string, unknown>[] | null) ?? []).map((g) => ({
        ...g,
        modifier_options: ((g.modifier_options as Record<string, unknown>[] | null) ?? [])
          .filter((o) => o.is_available)
          .sort((a, b) => (a.sort_order as number) - (b.sort_order as number)),
      })),
    }));

    return {
      categories: (categories ?? []) as MenuCategory[],
      items: cleanedItems as unknown as MenuItem[],
      deals: (deals ?? []) as unknown as DealLite[],
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
