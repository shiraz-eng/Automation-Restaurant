import { notFound } from 'next/navigation';
import { createTenantServerClient } from '@/lib/supabase/tenant-server';
import { gatePortalPage, can } from '@/lib/permissions';
import { SocialManager } from './SocialManager';

export const dynamic = 'force-dynamic';

export default async function SocialPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const t = await createTenantServerClient(slug);
  if (!t) notFound();

  const { role, perms } = await gatePortalPage(t.client, slug, 'social.view');
  const canManage = can(perms, role, 'social.manage');
  const canPropose = can(perms, role, 'social.propose_post');
  const canApprove = can(perms, role, 'social.approve_post');

  return (
    <div className="space-y-6 max-w-3xl">
      <div>
        <h1 className="text-xl font-black">Social</h1>
        <p className="text-muted text-xs mt-1">
          Connect Instagram and review AI-drafted posts — nothing goes live until you tap Publish here.
        </p>
      </div>
      <SocialManager slug={slug} canManage={canManage} canPropose={canPropose} canApprove={canApprove} />
    </div>
  );
}
