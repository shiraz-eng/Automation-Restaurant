import { notFound } from 'next/navigation';
import { createTenantServerClient } from '@/lib/supabase/tenant-server';
import { gatePortalPage } from '@/lib/permissions';
import { ExceptionsPanel } from './ExceptionsPanel';

export const dynamic = 'force-dynamic';

export default async function ExceptionsPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const t = await createTenantServerClient(slug);
  if (!t) notFound();
  await gatePortalPage(t.client, slug, 'orders.view');

  return (
    <div className="space-y-4 max-w-3xl">
      <div>
        <h1 className="text-xl font-black">Needs Attention</h1>
        <p className="text-muted text-xs mt-1">
          Everything the AI Assistant would flag if you asked &ldquo;what needs my attention&rdquo; — low stock,
          payment holds, overdue payables, kitchen delays, missing check-outs, a rating drop, or a recipe cost
          change — computed fresh from live data, ranked by severity.
        </p>
      </div>
      <ExceptionsPanel slug={slug} />
    </div>
  );
}
