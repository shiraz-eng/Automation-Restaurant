import { notFound } from 'next/navigation';
import { createTenantServerClient } from '@/lib/supabase/tenant-server';
import { fetchPortalTheme } from '@/lib/theme';
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
  const t = await createTenantServerClient(slug);
  if (!t) notFound();
  const { logoUrl } = await fetchPortalTheme(t.client);

  return (
    <SetPortalPasswordForm
      slug={slug}
      portalKey={p ?? ''}
      url={t.config.url}
      anonKey={t.config.anonKey}
      name={t.config.restaurantName}
      logoUrl={logoUrl}
    />
  );
}
