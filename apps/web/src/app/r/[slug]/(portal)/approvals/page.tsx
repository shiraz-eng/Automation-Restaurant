import { notFound } from 'next/navigation';
import { createTenantServerClient } from '@/lib/supabase/tenant-server';
import { gatePortalPage } from '@/lib/permissions';
import { ApprovalsPanel } from './ApprovalsPanel';

export const dynamic = 'force-dynamic';

export default async function ApprovalsPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const t = await createTenantServerClient(slug);
  if (!t) notFound();
  await gatePortalPage(t.client, slug, 'ai.approve_sensitive_action');

  return (
    <div className="space-y-4 max-w-3xl">
      <div>
        <h1 className="text-xl font-black">Approvals</h1>
        <p className="text-muted text-xs mt-1">
          Every action the AI Assistant has proposed and is still waiting on — from any chat, not just your own.
          Nothing here has happened yet; approving runs it, rejecting discards it.
        </p>
      </div>
      <ApprovalsPanel slug={slug} />
    </div>
  );
}
