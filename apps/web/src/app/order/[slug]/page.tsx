import { getTenantConfig } from '@/lib/tenant';
import { StorefrontClient, type MenuItem, type MenuCategory } from './StorefrontClient';

export const dynamic = 'force-dynamic';

const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

async function getMenu(slug: string) {
  try {
    const res = await fetch(`${API}/api/public/menu/${encodeURIComponent(slug)}`, {
      cache: 'no-store',
    });
    if (!res.ok) return null;
    return (await res.json()) as { categories: MenuCategory[]; items: MenuItem[] };
  } catch {
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
  const [config, menu] = await Promise.all([getTenantConfig(slug), getMenu(slug)]);

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
    />
  );
}
