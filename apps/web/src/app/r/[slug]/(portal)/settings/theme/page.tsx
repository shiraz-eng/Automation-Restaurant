import { notFound } from 'next/navigation';
import { createTenantServerClient } from '@/lib/supabase/tenant-server';
import { gatePortalPage, can } from '@/lib/permissions';
import { BrandKitSection } from './BrandKitSection';

export const dynamic = 'force-dynamic';

export default async function BrandKitPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const t = await createTenantServerClient(slug);
  if (!t) notFound();

  const { role, perms } = await gatePortalPage(t.client, slug, 'settings.view');
  const canEdit = can(perms, role, 'settings.update');

  return (
    <div className="space-y-10 max-w-3xl">
      <div>
        <h1 className="text-xl font-black">Brand Kit</h1>
        <p className="text-muted text-xs mt-1">
          This restaurant&apos;s visual identity — logo, colors, and receipt branding. Changes
          preview live across every portal screen in this browser; Save applies them for
          everyone, including the customer-facing menu.
        </p>
      </div>
      <BrandKitSection client={t.client} slug={slug} restaurantName={t.config.restaurantName} canEdit={canEdit} />
    </div>
  );
}
