import { createControlPlaneServerClient } from '@/lib/supabase/control-plane-server';
import { gateAdminPage } from '@/lib/adminPermissions';
import { AdminCard } from '../../_components/ui';
import { formatDateTime } from '@/lib/format';

export const dynamic = 'force-dynamic';

const ENTITIES = ['tenants', 'subscriptions', 'plans', 'site_sections', 'platform_admins', 'platform_roles'] as const;

type Row = {
  id: number;
  actor_email: string | null;
  actor_role: string | null;
  action: string;
  entity: string;
  entity_id: string | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  created_at: string;
};

/** Short description of what changed, favouring money/name/status fields. */
function describe(r: Row): string {
  const keys = ['name', 'restaurant_name', 'status', 'tier', 'role', 'is_active', 'price_monthly_cents'];
  if (r.action.includes('.')) {
    // domain event from app.log_admin_action — before/after are compact objects
    const parts = Object.entries(r.after ?? {}).map(([k, v]) => `${k}: ${JSON.stringify(v)}`);
    return parts.length ? parts.join(', ') : r.action;
  }
  if (r.action === 'INSERT') {
    const n = (r.after?.name ?? r.after?.restaurant_name ?? r.after?.email) as string | undefined;
    return n ? `added "${n}"` : 'created a record';
  }
  if (r.action === 'DELETE') {
    const n = (r.before?.name ?? r.before?.restaurant_name ?? r.before?.email) as string | undefined;
    return n ? `removed "${n}"` : 'deleted a record';
  }
  const changed = keys.filter(
    (k) => r.before && r.after && JSON.stringify(r.before[k]) !== JSON.stringify(r.after[k]),
  );
  if (changed.length === 0) return 'updated a record';
  return changed
    .map((k) => `${k}: ${JSON.stringify(r.before?.[k])} → ${JSON.stringify(r.after?.[k])}`)
    .join(', ');
}

export default async function AdminAuditLogsPage({
  searchParams,
}: {
  searchParams: Promise<{ entity?: string }>;
}) {
  const { entity } = await searchParams;
  const supabase = await createControlPlaneServerClient();
  await gateAdminPage(supabase, 'audit.view');

  let q = supabase
    .from('audit_logs')
    .select('id, actor_email, actor_role, action, entity, entity_id, before, after, created_at')
    .order('created_at', { ascending: false })
    .limit(200);
  if (entity && (ENTITIES as readonly string[]).includes(entity)) q = q.eq('entity', entity);

  const { data, error } = await q;
  const rows = (data ?? []) as Row[];

  return (
    <div className="space-y-6 max-w-4xl">
      <div>
        <h1 className="text-xl font-black">Audit log</h1>
        <p className="text-ink-muted text-xs mt-1">Every platform-level change — restaurants, subscriptions, plans, CMS, admin access.</p>
      </div>

      <div className="flex flex-wrap gap-1.5 text-xs">
        <a
          href="/admin/settings/audit-logs"
          className={`px-2.5 py-1 rounded font-semibold ${!entity ? 'bg-gold text-ink' : 'border border-white/15 text-ink-muted'}`}
        >
          All
        </a>
        {ENTITIES.map((e) => (
          <a
            key={e}
            href={`/admin/settings/audit-logs?entity=${e}`}
            className={`px-2.5 py-1 rounded font-semibold ${entity === e ? 'bg-gold text-ink' : 'border border-white/15 text-ink-muted'}`}
          >
            {e.replace(/_/g, ' ')}
          </a>
        ))}
      </div>

      {error ? (
        <div className="rounded-lg border border-red-500/40 bg-red-500/10 text-red-400 p-4 text-xs">{error.message}</div>
      ) : rows.length === 0 ? (
        <AdminCard>No activity recorded yet.</AdminCard>
      ) : (
        <AdminCard className="p-0 overflow-hidden">
          <table className="w-full text-left text-xs">
            <thead className="text-ink-muted border-b border-white/10">
              <tr>
                <th className="p-3 font-semibold">When</th>
                <th className="p-3 font-semibold">Who</th>
                <th className="p-3 font-semibold">Entity</th>
                <th className="p-3 font-semibold">Change</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-b border-white/10 last:border-0 align-top">
                  <td className="p-3 text-ink-muted whitespace-nowrap">{formatDateTime(r.created_at)}</td>
                  <td className="p-3">
                    <div>{r.actor_email ?? 'system'}</div>
                    <div className="text-ink-muted">{r.actor_role ?? '—'}</div>
                  </td>
                  <td className="p-3">
                    <span className="font-semibold">{r.entity.replace(/_/g, ' ')}</span>
                    <span
                      className={`ml-1.5 text-[10px] font-bold ${
                        r.action === 'DELETE' ? 'text-red-400' : r.action === 'INSERT' ? 'text-emerald-400' : 'text-gold'
                      }`}
                    >
                      {r.action}
                    </span>
                  </td>
                  <td className="p-3 text-ink-muted break-words max-w-[320px]">{describe(r)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </AdminCard>
      )}
    </div>
  );
}
