import { notFound, redirect } from 'next/navigation';
import { createTenantServerClient } from '@/lib/supabase/tenant-server';
import { Card } from '@/components/ui';

export const dynamic = 'force-dynamic';

const BLURB: Record<string, string> = {
  super_admin: 'Full control — use the admin portal at /r/<slug>.',
  checkout: 'Accept payment → print invoice → update order. Modules arrive in Phase 3.',
  kitchen: 'NEW → PREPARING → READY → COMPLETED, plus food availability. Modules arrive in Phase 3 & 6.',
  attendance: "Today's staff, check in / check out. Module arrives in Phase 7.",
  manager: 'Operational oversight scoped to its permissions.',
  custom: 'A custom portal limited to the permissions below.',
};

export default async function PortalHome({
  params,
}: {
  params: Promise<{ slug: string; portalKey: string }>;
}) {
  const { slug, portalKey } = await params;
  const t = await createTenantServerClient(slug);
  if (!t) notFound();

  const { data: portal } = await t.client
    .from('portals')
    .select('name, type, route_key, status, permissions')
    .eq('route_key', portalKey)
    .maybeSingle();
  if (!portal) notFound();
  if (portal.type === 'super_admin') redirect(`/r/${slug}`);

  const perms: string[] = portal.permissions ?? [];

  return (
    <div className="max-w-2xl space-y-6">
      <div>
        <h1 className="text-xl font-black">{portal.name}</h1>
        <p className="text-muted text-xs mt-1 capitalize">{portal.type.replace('_', ' ')} portal</p>
      </div>

      <Card>
        <p className="text-sm">{BLURB[portal.type] ?? BLURB.custom}</p>
      </Card>

      <Card>
        <h2 className="font-bold text-sm mb-3">This portal can</h2>
        {perms.length === 0 ? (
          <p className="text-muted text-xs">No permissions granted yet — configure in Portal Management.</p>
        ) : perms.includes('*') ? (
          <p className="text-xs">Everything.</p>
        ) : (
          <ul className="grid grid-cols-2 gap-x-6 gap-y-1 text-xs font-mono">
            {perms.map((p) => (
              <li key={p} className="text-ok">
                ✓ {p}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
