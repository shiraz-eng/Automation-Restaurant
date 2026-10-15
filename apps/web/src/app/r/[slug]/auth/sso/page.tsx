import { notFound } from 'next/navigation';
import { getTenantConfig } from '@/lib/tenant';
import { SsoClient } from './SsoClient';

export const dynamic = 'force-dynamic';

/**
 * The owner's one-time sign-in into one of their branches. The owner panel asks the API
 * for a token (POST /api/owner-branches/:id/open — owner only) and lands here with it in
 * the address fragment, which never reaches a server or a log. The browser exchanges it
 * for the owner's session in THIS restaurant's own cookie scope; the owner panel's own
 * session is untouched, so both stay signed in.
 */
export default async function BranchSsoPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const config = await getTenantConfig(slug);
  if (!config) notFound();
  return <SsoClient slug={slug} url={config.url} anonKey={config.anonKey} name={config.restaurantName} />;
}
