import { notFound } from 'next/navigation';
import { createTenantServerClient } from '@/lib/supabase/tenant-server';
import { gatePortalPage } from '@/lib/permissions';
import { AiChat } from './AiChat';

export const dynamic = 'force-dynamic';

export default async function AiPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const t = await createTenantServerClient(slug);
  if (!t) notFound();
  await gatePortalPage(t.client, slug, 'ai.view');

  return (
    <div className="space-y-4 max-w-3xl">
      <div>
        <h1 className="text-xl font-black">Assistant</h1>
        <p className="text-muted text-xs mt-1">
          Ask about today&apos;s numbers, the kitchen, stock or feedback. It reads live data with
          your permissions — it can&apos;t change anything.
        </p>
      </div>
      <AiChat slug={slug} />
    </div>
  );
}
