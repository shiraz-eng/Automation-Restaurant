'use client';

import { useState } from 'react';
import { DataTable, type Column } from '../_components/DataTable';
import { Drawer } from '../_components/Drawer';
import { AdminBadge } from '../_components/ui';
import type { CustomerAccount } from '@automation-restaurant/shared';

export function CustomersClient({ customers }: { customers: CustomerAccount[] }) {
  const [selected, setSelected] = useState<CustomerAccount | null>(null);

  const columns: Column<CustomerAccount>[] = [
    { key: 'owner', label: 'Owner', render: (c) => <span className="font-semibold">{c.ownerEmail}</span>, sortValue: (c) => c.ownerEmail },
    {
      key: 'restaurants',
      label: 'Restaurants',
      render: (c) => <span>{c.restaurantCount}</span>,
      sortValue: (c) => c.restaurantCount,
    },
    {
      key: 'mrr',
      label: 'Combined MRR',
      align: 'right',
      render: (c) => <span>${(c.mrrCents / 100).toLocaleString()}</span>,
      sortValue: (c) => c.mrrCents,
    },
    {
      key: 'status',
      label: 'Status',
      render: (c) => <AdminBadge status={c.hasPastDue ? 'past_due' : c.hasActive ? 'active' : 'inactive'} />,
    },
  ];

  return (
    <div className="space-y-3">
      <DataTable
        columns={columns}
        rows={customers}
        getRowId={(c) => c.ownerEmail}
        searchPlaceholder="Search customers…"
        searchValue={(c) => `${c.ownerEmail} ${c.restaurantNames.join(' ')}`}
        onRowClick={setSelected}
        emptyMessage="No customers yet."
      />
      <Drawer open={!!selected} onClose={() => setSelected(null)} title={selected?.ownerEmail ?? ''} subtitle={selected ? `${selected.restaurantCount} restaurant${selected.restaurantCount === 1 ? '' : 's'} · $${(selected.mrrCents / 100).toLocaleString()}/mo combined` : undefined}>
        {selected && (
          <div className="space-y-2">
            <div className="font-bold text-sm mb-1">Restaurants</div>
            {selected.restaurantNames.map((name, i) => (
              <div key={selected.tenantIds[i]} className="text-xs border-b border-white/10 last:border-0 py-2">
                {name}
              </div>
            ))}
            <p className="text-ink-muted text-[11px] pt-2">Open a restaurant from the Restaurants directory for subscription actions and invoices.</p>
          </div>
        )}
      </Drawer>
    </div>
  );
}
