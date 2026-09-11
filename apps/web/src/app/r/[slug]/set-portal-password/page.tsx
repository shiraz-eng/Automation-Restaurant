import { notFound } from 'next/navigation';
import { getTenantConfig } from '@/lib/tenant';
import { SetPortalPasswordForm } from './SetPortalPasswordForm';

export const dynamic = 'force-dynamic';

export default async function SetPortalPasswordPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ p?: string }>;
}) {
  const { slug } = await params;
  const { p } = await searchParams;
  const config = await getTenantConfig(slug);
  if (!config) notFound();

  return (
    <SetPortalPasswordForm
      slug={slug}
      portalKey={p ?? ''}
      url={config.url}
      anonKey={config.anonKey}
      name={config.restaurantName}
    />
  );
}
