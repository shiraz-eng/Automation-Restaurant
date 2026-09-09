'use client';

import { Fragment, useState } from 'react';
import { useRouter } from 'next/navigation';
import { usePortalSupabase } from '@/components/PortalProvider';
import { Card, Select } from '@/components/ui';
import { formatCents, formatDateTime } from '@/lib/format';

const STATUSES = ['pending', 'in_kitchen', 'ready', 'served', 'paid', 'void'] as const;

type Line = { name_snapshot: string; qty: number; line_total_cents: number; kds_status: string };
type Order = {
  id: string;
  order_number: number;
  status: string;
  channel: string;
  table_label: string | null;
  customer_name: string | null;
  subtotal_cents: number;
  tax_cents: number;
  total_cents: number;
  created_at: string;
  order_lines: Line[];
};

export function OrdersClient({ orders }: { orders: Order[] }) {
  const router = useRouter();
  const supabase = usePortalSupabase();
  const [expanded, setExpanded] = useState<string | null>(null);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function setStatus(id: string, status: string) {
    setSavingId(id);
    setError(null);
    const { error } = await supabase.from('orders').update({ status }).eq('id', id);
    setSavingId(null);
    if (error) {
      setError(error.message);
      return;
    }
    router.refresh();
  }

  if (orders.length === 0) return <Card>No orders yet.</Card>;

  return (
    <Card className="p-0 overflow-hidden">
      {error && <div className="bg-danger/10 text-danger text-xs p-3">{error}</div>}
      <table className="w-full text-left text-xs">
        <thead className="text-muted border-b border-border">
          <tr>
            <th className="p-3 font-semibold">#</th>
            <th className="p-3 font-semibold">Where</th>
            <th className="p-3 font-semibold">Items</th>
            <th className="p-3 font-semibold text-right">Total</th>
            <th className="p-3 font-semibold">Status</th>
            <th className="p-3 font-semibold text-right">Time</th>
          </tr>
        </thead>
        <tbody>
          {orders.map((o) => (
            <Fragment key={o.id}>
              <tr
                className="border-b border-border/60 hover:bg-main/50 cursor-pointer"
                onClick={() => setExpanded(expanded === o.id ? null : o.id)}
              >
                <td className="p-3 font-mono font-bold">{o.order_number}</td>
                <td className="p-3 text-muted">
                  {o.table_label ?? o.channel.replace('_', ' ')}
                  {o.customer_name ? ` · ${o.customer_name}` : ''}
                </td>
                <td className="p-3 text-muted">{o.order_lines?.length ?? 0}</td>
                <td className="p-3 text-right font-bold">{formatCents(o.total_cents)}</td>
                <td className="p-3" onClick={(e) => e.stopPropagation()}>
                  <Select
                    value={o.status}
                    disabled={savingId === o.id}
                    onChange={(e) => setStatus(o.id, e.target.value)}
                  >
                    {STATUSES.map((s) => (
                      <option key={s} value={s}>
                        {s.replace('_', ' ')}
                      </option>
                    ))}
                  </Select>
                </td>
                <td className="p-3 text-right text-muted">{formatDateTime(o.created_at)}</td>
              </tr>
              {expanded === o.id && (
                <tr className="border-b border-border/60 bg-main/30">
                  <td colSpan={6} className="p-3">
                    <div className="space-y-1">
                      {o.order_lines?.map((l, i) => (
                        <div key={i} className="flex justify-between text-xs">
                          <span>
                            {l.qty}× {l.name_snapshot}{' '}
                            <span className="text-muted">({l.kds_status})</span>
                          </span>
                          <span className="font-semibold">{formatCents(l.line_total_cents)}</span>
                        </div>
                      ))}
                      <div className="flex justify-between text-xs pt-1 border-t border-border mt-1 text-muted">
                        <span>subtotal {formatCents(o.subtotal_cents)}</span>
                        <span>tax {formatCents(o.tax_cents)}</span>
                        <span className="text-body font-bold">total {formatCents(o.total_cents)}</span>
                      </div>
                    </div>
                  </td>
                </tr>
              )}
            </Fragment>
          ))}
        </tbody>
      </table>
    </Card>
  );
}
