import { notFound } from 'next/navigation';
import QRCode from 'qrcode';
import { createTenantServerClient } from '@/lib/supabase/tenant-server';
import { gatePortalPage, can } from '@/lib/permissions';
import { loadBranchContext } from '@/lib/branchServer';
import { TablesManager, type TableRow } from './TablesManager';

export const dynamic = 'force-dynamic';

const SITE = process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3005';

export default async function TablesPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const t = await createTenantServerClient(slug);
  if (!t) notFound();
  const { role, perms } = await gatePortalPage(t.client, slug, 'tables.view');

  // Multi-branch: tables belong to a branch, and their QR codes carry its code (?b=DHA) so a
  // guest's order lands in that branch. Single-branch restaurants keep their plain QR codes.
  const branchCtx = await loadBranchContext(t.client);
  const branchCode = new Map(branchCtx.branches.map((b) => [b.id, b.code]));
  const { data, error } = await t.client
    .from('restaurant_tables')
    .select('*')
    .order('sort_order');

  const rows: TableRow[] = await Promise.all(
    (data ?? []).map(async (r) => {
      const code = branchCtx.multi ? branchCode.get((r as { branch_id?: string }).branch_id ?? '') : undefined;
      const url = `${SITE}/order/${slug}?table=${encodeURIComponent(r.label)}${code ? `&b=${code}` : ''}`;
      const qrSvg = await QRCode.toString(url, {
        type: 'svg',
        margin: 1,
        width: 150,
        color: { dark: '#0f172a', light: '#ffffff' },
      });
      return { ...r, url, qrSvg };
    }),
  );

  return (
    <div className="space-y-6 max-w-4xl">
      <h1 className="text-xl font-black">Tables &amp; QR codes</h1>
      {branchCtx.multi && (
        <p className="text-xs text-muted">
          {branchCtx.selected
            ? `Tables of ${branchCtx.selected.name}. New tables are added to this branch, and each QR code opens this branch's menu.`
            : 'Tables of every branch. Choose a branch in the menu to add tables to it.'}
        </p>
      )}
      {error ? (
        <div className="rounded-lg border border-danger/40 bg-danger/10 text-danger p-4 text-xs">
          {error.message}
        </div>
      ) : (
        <TablesManager
          rows={rows}
          canEdit={can(perms, role, 'tables.update')}
          canCreate={can(perms, role, 'tables.update') || can(perms, role, 'tables.create')}
        />
      )}
    </div>
  );
}
