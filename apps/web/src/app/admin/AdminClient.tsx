'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { createControlPlaneBrowserClient } from '@/lib/supabase/control-plane-client';
import { Card } from '@/components/ui';

export type TenantRow = {
  id: string;
  restaurant_name: string;
  slug: string;
  status: string;
  owner_email: string | null;
  region: string | null;
  provisioning_error: string | null;
  created_at: string;
  subscriptions: { tier: string; status: string; billing_interval: string } | null;
  tenant_projects: { project_ref: string; project_url: string } | null;
};

const STATUS_TONE: Record<string, string> = {
  active: 'text-ok',
  provisioning: 'text-warn',
  failed: 'text-danger',
  suspended: 'text-danger',
};

export function AdminClient({ rows }: { rows: TenantRow[] }) {
  const router = useRouter();
  const supabase = createControlPlaneBrowserClient();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function setStatus(id: string, status: string) {
    setBusyId(id);
    setError(null);
    const { error } = await supabase.from('tenants').update({ status }).eq('id', id);
    setBusyId(null);
    if (error) {
      setError(error.message);
      return;
    }
    router.refresh();
  }

  if (rows.length === 0) {
    return <Card>No restaurants provisioned yet.</Card>;
  }

  return (
    <Card className="p-0 overflow-hidden">
      {error && <div className="bg-danger/10 text-danger text-xs p-3">{error}</div>}
      <table className="w-full text-left text-xs">
        <thead className="text-muted border-b border-border">
          <tr>
            <th className="p-3 font-semibold">Restaurant</th>
            <th className="p-3 font-semibold">Owner</th>
            <th className="p-3 font-semibold">Plan</th>
            <th className="p-3 font-semibold">Project</th>
            <th className="p-3 font-semibold">Status</th>
            <th className="p-3 font-semibold text-right">Action</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className="border-b border-border/60 last:border-0 align-top">
              <td className="p-3">
                <div className="font-semibold">{r.restaurant_name}</div>
                <div className="text-muted font-mono">/r/{r.slug}</div>
              </td>
              <td className="p-3 text-muted">{r.owner_email ?? '—'}</td>
              <td className="p-3 capitalize">
                {r.subscriptions?.tier ?? '—'}
                {r.subscriptions ? (
                  <span className="text-muted"> · {r.subscriptions.status}</span>
                ) : null}
              </td>
              <td className="p-3 font-mono text-muted">
                {r.tenant_projects?.project_ref ?? '—'}
              </td>
              <td className={`p-3 font-semibold ${STATUS_TONE[r.status] ?? ''}`}>
                {r.status}
                {r.provisioning_error && (
                  <div className="text-danger font-normal max-w-[220px] truncate" title={r.provisioning_error}>
                    {r.provisioning_error}
                  </div>
                )}
              </td>
              <td className="p-3 text-right">
                {r.status === 'active' ? (
                  <button
                    onClick={() => setStatus(r.id, 'suspended')}
                    disabled={busyId === r.id}
                    className="rounded border border-danger/40 text-danger px-3 py-1.5 font-semibold hover:bg-danger/10"
                  >
                    Suspend
                  </button>
                ) : r.status === 'suspended' ? (
                  <button
                    onClick={() => setStatus(r.id, 'active')}
                    disabled={busyId === r.id}
                    className="rounded bg-primary text-primary-fg px-3 py-1.5 font-semibold"
                  >
                    Reactivate
                  </button>
                ) : (
                  <span className="text-muted">—</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}
