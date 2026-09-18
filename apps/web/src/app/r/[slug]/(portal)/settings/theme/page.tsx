import { notFound } from 'next/navigation';
import { createTenantServerClient } from '@/lib/supabase/tenant-server';
import { gatePortalPage, can } from '@/lib/permissions';
import { BrandKitManager } from './BrandKitManager';

export const dynamic = 'force-dynamic';

export default async function BrandKitPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const t = await createTenantServerClient(slug);
  if (!t) notFound();

  const { role, perms } = await gatePortalPage(t.client, slug, 'settings.view');
  const canEdit = can(perms, role, 'settings.update');

  const { data, error } = await t.client
    .from('business_settings')
    .select(
      'brand_logo_url, receipt_footer_text, receipt_template_html, brand_primary, brand_primary_fg, brand_bg_main, brand_bg_surface, brand_border, brand_text_body, brand_text_muted, brand_radius, brand_appearance',
    )
    .eq('id', true)
    .maybeSingle();

  return (
    <div className="space-y-6 max-w-3xl">
      <div>
        <h1 className="text-xl font-black">Brand Kit</h1>
        <p className="text-muted text-xs mt-1">
          This restaurant&apos;s visual identity — logo, colors, and receipt branding. Changes
          preview live across every portal screen in this browser; Save applies them for
          everyone, including the customer-facing menu.
        </p>
      </div>
      {error ? (
        <div className="rounded-lg border border-danger/40 bg-danger/10 text-danger p-4 text-xs">{error.message}</div>
      ) : (
        <BrandKitManager
          slug={slug}
          logoUrl={data?.brand_logo_url ?? null}
          receiptFooterText={data?.receipt_footer_text ?? null}
          receiptTemplateHtml={data?.receipt_template_html ?? null}
          canEdit={canEdit}
        />
      )}
    </div>
  );
}
