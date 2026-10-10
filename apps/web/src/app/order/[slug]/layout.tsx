import type { Metadata } from 'next';
import { createClient } from '@supabase/supabase-js';
import { buildOrderMetadata } from '@/lib/portalMetadata';
import { getTenantConfig } from '@/lib/tenant';
import { loadTenantCurrency } from '@/lib/currencyServer';
import { CurrencySync } from '@/components/CurrencySync';

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  return buildOrderMetadata(slug);
}

/** Guest menu, ordering and tracking — prices in the restaurant's own currency. */
export default async function OrderLayout({ children, params }: { children: React.ReactNode; params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const config = await getTenantConfig(slug).catch(() => null);
  const currency = config ? await loadTenantCurrency(createClient(config.url, config.anonKey)).catch(() => 'USD') : 'USD';
  return <CurrencySync code={currency}>{children}</CurrencySync>;
}
