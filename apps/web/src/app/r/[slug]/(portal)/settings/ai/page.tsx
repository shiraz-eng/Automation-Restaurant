import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { createTenantServerClient } from '@/lib/supabase/tenant-server';
import { gatePortalPage, can } from '@/lib/permissions';
import { AiSettingsManager } from './AiSettingsManager';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'AI & Voice' };

export default async function AiSettingsPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const t = await createTenantServerClient(slug);
  if (!t) notFound();
  const { role, perms } = await gatePortalPage(t.client, slug, 'settings.view');

  return (
    <div className="space-y-6 max-w-4xl">
      <div>
        <h1 className="text-xl font-black">AI &amp; Voice</h1>
        <p className="text-muted text-xs mt-1">
          Which AI model answers in each module, the languages it listens for and answers in, and whether voice is
          offered. These settings never change what anyone can see or do — the assistant always works with the
          signed-in person&apos;s own permissions.
        </p>
      </div>
      <AiSettingsManager slug={slug} canEdit={can(perms, role, 'settings.update')} />
    </div>
  );
}
