import { notFound } from 'next/navigation';
import { createTenantServerClient } from '@/lib/supabase/tenant-server';
import { gatePortalPage } from '@/lib/permissions';
import { Card } from '@/components/ui';
import { formatDateTime } from '@/lib/format';

export const dynamic = 'force-dynamic';

const ENTITIES = [
  'menu_categories',
  'menu_items',
  'inventory_items',
  'recipe_components',
  'memberships',
  'restaurant_tables',
  'reservations',
] as const;

type Row = {
  id: number;
  actor_email: string | null;
  actor_role: string | null;
  portal_id: string | null;
  action: string;
  entity: string;
  entity_id: string | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  created_at: string;
};

/** Short description of what changed, favouring money/name/status fields. */
function describe(r: Row): string {
  const keys = ['name', 'label', 'price_cents', 'stock_qty', 'role', 'status', 'is_available'];
  if (r.action.includes('.')) {
    // domain event from app.log_action — before/after are compact objects
    const parts = Object.entries(r.after ?? {}).map(([k, v]) => `${k}: ${JSON.stringify(v)}`);
    return parts.length ? parts.join(', ') : r.action;
  }
  if (r.action === 'INSERT') {
    const n = (r.after?.name ?? r.after?.label ?? r.after?.email) as string | undefined;
    return n ? `added “${n}”` : 'created a record';
  }
  if (r.action === 'DELETE') {
    const n = (r.before?.name ?? r.before?.label ?? r.before?.email) as string | undefined;
    return n ? `removed “${n}”` : 'deleted a record';
  }
  const changed = keys.filter(
    (k) => r.before && r.after && JSON.stringify(r.before[k]) !== JSON.stringify(r.after[k]),
  );
  if (changed.length === 0) return 'updated a record';
  return changed
    .map((k) => `${k}: ${JSON.stringify(r.before?.[k])} → ${JSON.stringify(r.after?.[k])}`)
    .join(', ');
}

export default async function AuditPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ entity?: string }>;
}) {
  const { slug } = await params;
  const { entity } = await searchParams;
  const t = await createTenantServerClient(slug);
  if (!t) notFound();
  await gatePortalPage(t.client, slug, 'reports.view');

  let q = t.client
    .from('audit_logs')
    .select('id, actor_email, actor_role, portal_id, action, entity, entity_id, before, after, created_at')
    .order('created_at', { ascending: false })
    .limit(200);
  if (entity && (ENTITIES as readonly string[]).includes(entity)) q = q.eq('entity', entity);

  const { data, error } = await q;
  const rows = (data ?? []) as Row[];

  return (
    <div className="space-y-6 max-w-4xl">
      <h1 className="text-xl font-black">Audit log</h1>

      <div className="flex flex-wrap gap-1.5 text-xs">
        <a
          href={`/r/${slug}/audit`}
          className={`px-2.5 py-1 rounded font-semibold ${!entity ? 'bg-primary text-primary-fg' : 'border border-border'}`}
        >
          All
        </a>
        {ENTITIES.map((e) => (
          <a
            key={e}
            href={`/r/${slug}/audit?entity=${e}`}
            className={`px-2.5 py-1 rounded font-semibold ${entity === e ? 'bg-primary text-primary-fg' : 'border border-border'}`}
          >
            {e.replace(/_/g, ' ')}
          </a>
        ))}
      </div>

      {error ? (
        <div className="rounded-lg border border-danger/40 bg-danger/10 text-danger p-4 text-xs">
          {error.message}
        </div>
      ) : rows.length === 0 ? (
        <Card>No activity recorded yet.</Card>
      ) : (
        <Card className="p-0 overflow-hidden">
          <table className="w-full text-left text-xs">
            <thead className="text-muted border-b border-border">
              <tr>
                <th className="p-3 font-semibold">When</th>
                <th className="p-3 font-semibold">Who</th>
                <th className="p-3 font-semibold">Entity</th>
                <th className="p-3 font-semibold">Change</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-b border-border/60 last:border-0 align-top">
                  <td className="p-3 text-muted whitespace-nowrap">
                    {formatDateTime(r.created_at)}
                  </td>
                  <td className="p-3">
                    <div>{r.actor_email ?? 'system'}</div>
                    <div className="text-muted">
                      {r.actor_role ?? '—'}
                      {r.portal_id ? ' · portal' : ''}
                    </div>
                  </td>
                  <td className="p-3">
                    <span className="font-semibold">{r.entity.replace(/_/g, ' ')}</span>
                    <span
                      className={`ml-1.5 text-[10px] font-bold ${
                        r.action === 'DELETE'
                          ? 'text-danger'
                          : r.action === 'INSERT'
                            ? 'text-ok'
                            : 'text-warn'
                      }`}
                    >
                      {r.action}
                    </span>
                  </td>
                  <td className="p-3 text-muted break-words max-w-[320px]">{describe(r)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}
