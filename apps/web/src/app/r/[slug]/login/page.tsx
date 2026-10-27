import { notFound } from 'next/navigation';
import { createTenantServerClient } from '@/lib/supabase/tenant-server';
import { fetchPortalTheme } from '@/lib/theme';
import { LoginForm } from './LoginForm';
import { UiTranslator } from '@/components/UiTranslator';
import { LanguageMenu } from '@/components/LanguageMenu';

export const dynamic = 'force-dynamic';

export default async function TenantLoginPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const t = await createTenantServerClient(slug);
  if (!t) notFound();
  const { logoUrl } = await fetchPortalTheme(t.client);

  return (
    <>
      <UiTranslator slug={slug} />
      <div className="fixed end-4 top-4 z-10">
        <LanguageMenu />
      </div>
      <LoginForm
        slug={slug}
        url={t.config.url}
        anonKey={t.config.anonKey}
        name={t.config.restaurantName}
        logoUrl={logoUrl}
      />
    </>
  );
}
