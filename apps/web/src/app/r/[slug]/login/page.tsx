import { notFound } from 'next/navigation';
import { getTenantConfig } from '@/lib/tenant';
import { LoginForm } from './LoginForm';

export const dynamic = 'force-dynamic';

export default async function TenantLoginPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const config = await getTenantConfig(slug);
  if (!config) notFound();

  return (
    <LoginForm
      slug={slug}
      url={config.url}
      anonKey={config.anonKey}
      name={config.restaurantName}
    />
  );
}
