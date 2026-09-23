'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { createControlPlaneBrowserClient } from '@/lib/supabase/control-plane-client';
import { canAdmin } from '@/lib/adminPermissions';
import { DataTable, type Column } from '../_components/DataTable';
import { AdminButton, AdminBadge } from '../_components/ui';
import { RestaurantDetailDrawer, type DrawerTenant } from '../_components/RestaurantDetailDrawer';
import { computeMrrCents, type PlanLite } from '@automation-restaurant/shared';

const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

export type TenantRow = DrawerTenant & {
  provisioning_error: string | null;
  welcome_email_status: string | null;
  welcome_email_error: string | null;
  provisioning_attempts: number | null;
  created_at: string;
  tenant_projects: { project_ref: string; project_url: string } | null;
};

export function RestaurantsClient({
  rows,
  plans,
  role,
  perms,
}: {
  rows: TenantRow[];
  plans: PlanLite[];
  role: string;
  perms: string[];
}) {
  const router = useRouter();
  const supabase = createControlPlaneBrowserClient();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<TenantRow | null>(null);
  const canManageRestaurant = canAdmin(perms, role, 'restaurants.manage');
  const planTiers = plans.map((p) => p.tier);

  async function setStatus(id: string, status: string) {
    setBusyId(id);
    setError(null);
    const { error } = await supabase.from('tenants').update({ status }).eq('id', id);
    setBusyId(null);
    if (error) return setError(error.message);
    router.refresh();
  }

  async function callAdmin(id: string, path: string) {
    setBusyId(id);
    setError(null);
    const {
      data: { session },
    } = await supabase.auth.getSession();
    try {
      const res = await fetch(`${API}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session?.access_token ?? ''}` },
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || body.ok === false) setError(body.message ?? body.error ?? 'Action failed');
    } catch {
      setError('Network error.');
    } finally {
      setBusyId(null);
      router.refresh();
    }
  }

  const columns: Column<TenantRow>[] = [
    {
      key: 'restaurant',
      label: 'Restaurant',
      render: (r) => (
        <div>
          <div className="font-semibold">{r.restaurant_name}</div>
          <div className="text-ink-muted font-mono">/r/{r.slug}</div>
        </div>
      ),
      sortValue: (r) => r.restaurant_name,
    },
    { key: 'owner', label: 'Owner', render: (r) => <span className="text-ink-muted">{r.owner_email ?? '—'}</span> },
    {
      key: 'plan',
      label: 'Plan',
      render: (r) => (
        <span className="capitalize">
          {r.subscriptions?.tier ?? '—'}
          {r.subscriptions ? <span className="text-ink-muted"> · {r.subscriptions.status}</span> : null}
        </span>
      ),
    },
    {
      key: 'mrr',
      label: 'MRR',
      align: 'right',
      render: (r) => <span>${(computeMrrCents(r.subscriptions ? [r.subscriptions as never] : [], plans) / 100).toLocaleString()}</span>,
      sortValue: (r) => (r.subscriptions ? computeMrrCents([r.subscriptions as never], plans) : 0),
    },
    {
      key: 'renewal',
      label: 'Renewal',
      render: (r) => (
        <span className="text-ink-muted">
          {r.subscriptions?.current_period_end ? new Date(r.subscriptions.current_period_end).toLocaleDateString() : '—'}
        </span>
      ),
    },
    {
      key: 'status',
      label: 'Status',
      render: (r) => (
        <div>
          <AdminBadge status={r.status} />
          {r.provisioning_error && (
            <div className="text-red-400 max-w-[180px] truncate mt-1" title={r.provisioning_error}>
              {r.provisioning_error}
            </div>
          )}
        </div>
      ),
    },
    {
      key: 'action',
      label: 'Action',
      align: 'right',
      render: (r) => (
        <div onClick={(e) => e.stopPropagation()} className="whitespace-nowrap">
          {!canManageRestaurant ? (
            <span className="text-ink-muted">—</span>
          ) : r.status === 'failed' ? (
            <AdminButton disabled={busyId === r.id} onClick={() => callAdmin(r.id, `/api/admin/tenants/${r.slug}/retry-provision`)}>
              Retry
            </AdminButton>
          ) : r.status === 'active' ? (
            <div className="flex gap-1.5">
              <AdminButton variant="ghost" disabled={busyId === r.id} onClick={() => callAdmin(r.id, `/api/admin/tenants/${r.slug}/resend-welcome`)}>
                Resend
              </AdminButton>
              <AdminButton variant="danger" disabled={busyId === r.id} onClick={() => setStatus(r.id, 'suspended')}>
                Suspend
              </AdminButton>
            </div>
          ) : r.status === 'suspended' ? (
            <AdminButton disabled={busyId === r.id} onClick={() => setStatus(r.id, 'active')}>
              Reactivate
            </AdminButton>
          ) : (
            <span className="text-ink-muted">—</span>
          )}
        </div>
      ),
    },
  ];

  return (
    <div className="space-y-3">
      {error && <div className="bg-red-500/10 text-red-400 text-xs p-3 rounded-lg">{error}</div>}
      <DataTable
        columns={columns}
        rows={rows}
        getRowId={(r) => r.id}
        searchPlaceholder="Search restaurants or owners…"
        searchValue={(r) => `${r.restaurant_name} ${r.owner_email ?? ''} ${r.slug}`}
        onRowClick={setSelected}
        emptyMessage="No restaurants provisioned yet."
      />
      <RestaurantDetailDrawer tenant={selected} onClose={() => setSelected(null)} role={role} perms={perms} planTiers={planTiers} />
    </div>
  );
}
