'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { usePortalSupabase } from '@/components/PortalProvider';
import { formatCents } from '@/lib/format';

type Line = { id: string; name_snapshot: string; qty: number; kds_status: string };
export type FloorOrder = {
  id: string;
  order_number: number;
  table_label: string | null;
  customer_name: string | null;
  status: string;
  total_cents: number;
  created_at: string;
  order_lines: Line[];
};

const ACTIVE = ['pending', 'in_kitchen', 'ready', 'served'];

const KITCHEN_TONE: Record<string, string> = {
  ready: 'text-ok',
  in_kitchen: 'text-warn',
  pending: 'text-muted',
  served: 'text-muted',
};

export function FloorClient({ initial }: { initial: FloorOrder[] }) {
  const supabase = usePortalSupabase();
  const [orders, setOrders] = useState<FloorOrder[]>(initial);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    const { data } = await supabase
      .from('orders')
      .select(
        'id, order_number, table_label, customer_name, status, total_cents, created_at, order_lines(id, name_snapshot, qty, kds_status)',
      )
      .in('status', ACTIVE)
      .order('created_at', { ascending: true });
    if (data) setOrders(data as FloorOrder[]);
  }, [supabase]);

  useEffect(() => {
    const ch = supabase
      .channel('floor-orders')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'orders' }, () => load())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'order_lines' }, () => load())
      .subscribe();
    return () => {
      supabase.removeChannel(ch);
    };
  }, [supabase, load]);

  const byTable = useMemo(() => {
    const map = new Map<string, { orders: FloorOrder[]; total: number }>();
    for (const o of orders) {
      const key = o.table_label ?? 'No table';
      const entry = map.get(key) ?? { orders: [], total: 0 };
      entry.orders.push(o);
      entry.total += o.total_cents;
      map.set(key, entry);
    }
    return [...map.entries()];
  }, [orders]);

  async function markServed(o: FloorOrder) {
    setBusyId(o.id);
    setOrders((os) =>
      os.map((x) =>
        x.id === o.id
          ? { ...x, status: 'served', order_lines: x.order_lines.map((l) => ({ ...l, kds_status: 'served' })) }
          : x,
      ),
    );
    await supabase.from('order_lines').update({ kds_status: 'served' }).eq('order_id', o.id);
    await supabase.from('orders').update({ status: 'served' }).eq('id', o.id);
    setBusyId(null);
    load();
  }

  if (byTable.length === 0) {
    return (
      <div className="rounded-lg border border-border bg-surface p-10 text-center text-muted text-sm">
        No active tables.
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3">
      {byTable.map(([table, entry]) => (
        <section key={table} className="rounded-lg border border-border bg-surface p-4">
          <div className="flex items-baseline justify-between mb-3">
            <span className="font-black">{table}</span>
            <span className="text-xs text-muted">running {formatCents(entry.total)}</span>
          </div>
          <div className="space-y-3">
            {entry.orders.map((o) => (
              <div key={o.id} className="rounded border border-border p-2.5">
                <div className="flex items-baseline justify-between text-xs mb-1">
                    <span className="font-bold">
                      #{o.order_number}
                      {o.customer_name ? ` · ${o.customer_name}` : ''}
                    </span>
                    <span
                      className={`font-semibold ${KITCHEN_TONE[o.status] ?? 'text-body'}`}
                    >
                      {o.status.replace('_', ' ')}
                    </span>
                  </div>
                  <ul className="text-xs space-y-0.5 mb-2">
                    {o.order_lines.map((l) => (
                      <li key={l.id}>
                        {l.qty}× {l.name_snapshot}
                      </li>
                    ))}
                  </ul>
                {o.status !== 'served' && (
                  <button
                    onClick={() => markServed(o)}
                    disabled={busyId === o.id}
                    className="w-full rounded bg-primary text-primary-fg font-bold py-2 text-xs disabled:opacity-50"
                  >
                    Mark served
                  </button>
                )}
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
