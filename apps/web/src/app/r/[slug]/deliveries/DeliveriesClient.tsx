'use client';

import { useCallback, useEffect, useState } from 'react';
import { usePortalSupabase } from '@/components/PortalProvider';
import { formatCents } from '@/lib/format';

type Line = { name_snapshot: string; qty: number };
export type Delivery = {
  id: string;
  order_number: number;
  customer_name: string | null;
  table_label: string | null;
  status: string;
  total_cents: number;
  created_at: string;
  order_lines: Line[];
};

const ACTIVE = ['pending', 'in_kitchen', 'ready', 'served'];

// Delivery driver's view of the order lifecycle, mapped onto order.status:
//   in kitchen  → being prepared
//   ready       → ready for pickup   [button: Out for delivery -> no status change, local only]
//   served      → delivered
const STAGE_LABEL: Record<string, string> = {
  pending: 'Received',
  in_kitchen: 'Preparing',
  ready: 'Ready for pickup',
  served: 'Delivered',
};

export function DeliveriesClient({ initial }: { initial: Delivery[] }) {
  const supabase = usePortalSupabase();
  const [rows, setRows] = useState<Delivery[]>(initial);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    const { data } = await supabase
      .from('orders')
      .select(
        'id, order_number, customer_name, table_label, status, total_cents, created_at, order_lines(name_snapshot, qty)',
      )
      .eq('channel', 'delivery')
      .in('status', ACTIVE)
      .order('created_at', { ascending: true });
    if (data) setRows(data as Delivery[]);
  }, [supabase]);

  useEffect(() => {
    const ch = supabase
      .channel('deliveries-orders')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'orders' }, () => load())
      .subscribe();
    return () => {
      supabase.removeChannel(ch);
    };
  }, [supabase, load]);

  async function deliver(d: Delivery) {
    setBusyId(d.id);
    setRows((rs) => rs.filter((x) => x.id !== d.id));
    await supabase.from('orders').update({ status: 'served' }).eq('id', d.id);
    setBusyId(null);
    load();
  }

  if (rows.length === 0) {
    return (
      <div className="rounded-lg border border-border bg-surface p-10 text-center text-muted text-sm">
        No active deliveries.
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3">
      {rows.map((d) => {
        const isPicked = picked.has(d.id);
        return (
          <div key={d.id} className="rounded-lg border border-border bg-surface p-4">
            <div className="flex items-baseline justify-between mb-2">
              <span className="font-black">#{d.order_number}</span>
              <span className="text-xs text-warn font-semibold">
                {STAGE_LABEL[d.status] ?? d.status}
              </span>
            </div>
            <div className="text-xs mb-1">{d.customer_name ?? 'Guest'}</div>
            <div className="text-xs text-muted mb-2">{d.table_label ?? 'address on ticket'}</div>
            <ul className="text-xs space-y-0.5 mb-2">
              {d.order_lines.map((l, i) => (
                <li key={i}>
                  {l.qty}× {l.name_snapshot}
                </li>
              ))}
            </ul>
            <div className="text-xs text-muted mb-3">collect {formatCents(d.total_cents)}</div>

            {d.status !== 'ready' && d.status !== 'served' ? (
              <p className="text-xs text-muted">Waiting for kitchen…</p>
            ) : !isPicked ? (
              <button
                onClick={() => setPicked((s) => new Set(s).add(d.id))}
                className="w-full rounded border border-border font-bold py-2 text-xs"
              >
                Picked up · out for delivery
              </button>
            ) : (
              <button
                onClick={() => deliver(d)}
                disabled={busyId === d.id}
                className="w-full rounded bg-primary text-primary-fg font-bold py-2 text-xs disabled:opacity-50"
              >
                Mark delivered
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}
