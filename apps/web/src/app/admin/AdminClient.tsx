'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { createControlPlaneBrowserClient } from '@/lib/supabase/control-plane-client';
import { AdminCard } from './_components/ui';

export type TenantRow = {
  id: string;
  restaurant_name: string;
  slug: string;
  status: string;
  owner_email: string | null;
  region: string | null;
  provisioning_error: string | null;
  welcome_email_status: string | null;
  welcome_email_error: string | null;
  provisioning_attempts: number | null;
  created_at: string;
  subscriptions: { tier: string; status: string; billing_interval: string } | null;
  tenant_projects: { project_ref: string; project_url: string } | null;
};

const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

const STATUS_TONE: Record<string, string> = {
  active: 'text-emerald-400',
  provisioning: 'text-gold',
  failed: 'text-red-400',
  suspended: 'text-red-400',
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

  async function callAdmin(id: string, path: string, ok: string) {
    setBusyId(id);
    setError(null);
    const {
      data: { session },
    } = await supabase.auth.getSession();
    try {
      const res = await fetch(`${API}${path}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session?.access_token ?? ''}`,
        },
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || body.ok === false) {
        setError(body.message ?? body.error ?? `${ok} failed`);
      }
    } catch {
      setError('Network error.');
    } finally {
      setBusyId(null);
      router.refresh();
    }
  }

  if (rows.length === 0) {
    return <AdminCard>No restaurants provisioned yet.</AdminCard>;
  }

  return (
    <AdminCard className="p-0 overflow-hidden">
      {error && <div className="bg-red-500/10 text-red-400 text-xs p-3">{error}</div>}
      <table className="w-full text-left text-xs">
        <thead className="text-ink-muted border-b border-white/10">
          <tr>
            <th className="p-3 font-semibold">Restaurant</th>
            <th className="p-3 font-semibold">Owner</th>
            <th className="p-3 font-semibold">Plan</th>
            <th className="p-3 font-semibold">Project</th>
            <th className="p-3 font-semibold">Status</th>
            <th className="p-3 font-semibold">Welcome email</th>
            <th className="p-3 font-semibold text-right">Action</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className="border-b border-white/10 last:border-0 align-top">
              <td className="p-3">
                <div className="font-semibold">{r.restaurant_name}</div>
                <div className="text-ink-muted font-mono">/r/{r.slug}</div>
              </td>
              <td className="p-3 text-ink-muted">{r.owner_email ?? '—'}</td>
              <td className="p-3 capitalize">
                {r.subscriptions?.tier ?? '—'}
                {r.subscriptions ? (
                  <span className="text-ink-muted"> · {r.subscriptions.status}</span>
                ) : null}
              </td>
              <td className="p-3 font-mono text-ink-muted">
                {r.tenant_projects?.project_ref ?? '—'}
              </td>
              <td className={`p-3 font-semibold ${STATUS_TONE[r.status] ?? ''}`}>
                {r.status}
                {r.provisioning_attempts ? (
                  <span className="text-ink-muted font-normal"> · {r.provisioning_attempts} tries</span>
                ) : null}
                {r.provisioning_error && (
                  <div className="text-red-400 font-normal max-w-[220px] truncate" title={r.provisioning_error}>
                    {r.provisioning_error}
                  </div>
                )}
              </td>
              <td className="p-3">
                <span
                  className={
                    r.welcome_email_status === 'sent'
                      ? 'text-emerald-400'
                      : r.welcome_email_status === 'failed'
                        ? 'text-red-400'
                        : 'text-ink-muted'
                  }
                >
                  {r.welcome_email_status ?? '—'}
                </span>
                {r.welcome_email_error && (
                  <div
                    className="text-red-400 max-w-[180px] truncate"
                    title={r.welcome_email_error}
                  >
                    {r.welcome_email_error}
                  </div>
                )}
              </td>
              <td className="p-3 text-right whitespace-nowrap">
                {r.status === 'failed' && (
                  <button
                    onClick={() =>
                      callAdmin(r.id, `/api/admin/tenants/${r.slug}/retry-provision`, 'Retry')
                    }
                    disabled={busyId === r.id}
                    className="rounded bg-gold text-ink px-3 py-1.5 font-semibold hover:bg-gold/90 transition-colors"
                  >
                    Retry provisioning
                  </button>
                )}
                {r.status === 'active' && (
                  <>
                    <button
                      onClick={() =>
                        callAdmin(r.id, `/api/admin/tenants/${r.slug}/resend-welcome`, 'Resend')
                      }
                      disabled={busyId === r.id}
                      className="rounded border border-white/15 px-3 py-1.5 font-semibold hover:bg-white/5 transition-colors"
                    >
                      Resend email
                    </button>
                    <button
                      onClick={() => setStatus(r.id, 'suspended')}
                      disabled={busyId === r.id}
                      className="ml-1.5 rounded border border-red-500/40 text-red-400 px-3 py-1.5 font-semibold hover:bg-red-500/10 transition-colors"
                    >
                      Suspend
                    </button>
                  </>
                )}
                {r.status === 'suspended' && (
                  <button
                    onClick={() => setStatus(r.id, 'active')}
                    disabled={busyId === r.id}
                    className="rounded bg-gold text-ink px-3 py-1.5 font-semibold hover:bg-gold/90 transition-colors"
                  >
                    Reactivate
                  </button>
                )}
                {!['failed', 'active', 'suspended'].includes(r.status) && (
                  <span className="text-ink-muted">—</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </AdminCard>
  );
}
