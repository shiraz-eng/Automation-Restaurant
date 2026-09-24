'use client';

import { Fragment, useState } from 'react';
import { useRouter } from 'next/navigation';
import { usePortalSupabase } from '@/components/PortalProvider';
import { Card, Select } from '@/components/ui';
import { formatCents, formatDateTime } from '@/lib/format';

// Kitchen-stage progression only. "paid" is reached exclusively through
// record_payment (Checkout) so it always carries a real payment and a
// paid_at timestamp; "void" goes through cancel_order below, which is
// audited and refuses to cancel an already-paid order. Editing either
// directly here used to let staff mark an order "paid" with $0 collected —
// see the Cancel button for the replacement void path.
const EDITABLE_STATUSES = ['pending', 'in_kitchen', 'ready', 'served'] as const;
const TERMINAL_LABEL: Record<string, string> = { paid: 'Paid', void: 'Void' };

type Line = { name_snapshot: string; qty: number; line_total_cents: number; kds_status: string };
export type Order = {
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

export function OrdersClient({
  orders,
  canCancel,
  canUpdateStatus,
  canReopen = false,
}: {
  orders: Order[];
  canCancel: boolean;
  /** orders.update — matches the orders table's staff_update RLS policy. */
  canUpdateStatus: boolean;
  /** orders.reopen — reopen_order() moves a served/paid order back to ready. */
  canReopen?: boolean;
}) {
  const router = useRouter();
  const supabase = usePortalSupabase();
  const [expanded, setExpanded] = useState<string | null>(null);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function setStatus(id: string, status: string) {
    setSavingId(id);
    setError(null);
    // order_lines.kds_status is kept in sync with this write by a database
    // trigger (0051_order_status_line_sync.sql) — added because this page's
    // direct status write (orders.update permission) and the Kitchen
    // board's kitchen_* RPCs (kitchen.update_status permission) are two
    // different, independently-permissioned paths to the same field, and
    // only fixing the frontend here would silently break status changes
    // for any custom portal granted one permission but not the other.
    const { error } = await supabase.from('orders').update({ status }).eq('id', id);
    setSavingId(null);
    if (error) {
      setError(error.message);
      return;
    }
    router.refresh();
  }

  async function cancel(order: Order) {
    const reason = window.prompt(`Cancel order #${order.order_number}. Reason:`);
    if (!reason) return;
    setSavingId(order.id);
    setError(null);
    const { error } = await supabase.rpc('cancel_order', { p_order_id: order.id, p_reason: reason });
    setSavingId(null);
    if (error) {
      setError(error.message);
      return;
    }
    router.refresh();
  }

  async function reopen(order: Order) {
    const reason = window.prompt(`Reopen order #${order.order_number}. Reason:`);
    if (!reason) return;
    setSavingId(order.id);
    setError(null);
    const { error } = await supabase.rpc('reopen_order', { p_order_id: order.id, p_reason: reason });
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
          {orders.map((o) => {
            const isTerminal = o.status === 'paid' || o.status === 'void';
            return (
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
                  {isTerminal ? (
                    <div className="flex items-center gap-2">
                      <span
                        className={`inline-block rounded px-2 py-1 text-xs font-semibold ${
                          o.status === 'paid' ? 'bg-ok/10 text-ok' : 'bg-danger/10 text-danger'
                        }`}
                      >
                        {TERMINAL_LABEL[o.status] ?? o.status}
                      </span>
                      {canReopen && o.status === 'paid' && (
                        <button
                          onClick={() => reopen(o)}
                          disabled={savingId === o.id}
                          className="text-primary text-xs underline shrink-0 disabled:opacity-50"
                        >
                          reopen
                        </button>
                      )}
                    </div>
                  ) : (
                    <div className="flex items-center gap-2">
                      {canUpdateStatus ? (
                        <Select
                          value={o.status}
                          disabled={savingId === o.id}
                          onChange={(e) => setStatus(o.id, e.target.value)}
                        >
                          {EDITABLE_STATUSES.map((s) => (
                            <option key={s} value={s}>
                              {s.replace('_', ' ')}
                            </option>
                          ))}
                        </Select>
                      ) : (
                        <span className="inline-block rounded px-2 py-1 text-xs font-semibold bg-main text-muted capitalize">
                          {o.status.replace('_', ' ')}
                        </span>
                      )}
                      {canReopen && o.status === 'served' && (
                        <button
                          onClick={() => reopen(o)}
                          disabled={savingId === o.id}
                          className="text-primary text-xs underline shrink-0 disabled:opacity-50"
                        >
                          reopen
                        </button>
                      )}
                      {canCancel && (
                        <button
                          onClick={() => cancel(o)}
                          disabled={savingId === o.id}
                          className="text-danger text-xs underline shrink-0 disabled:opacity-50"
                        >
                          cancel
                        </button>
                      )}
                    </div>
                  )}
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
            );
          })}
        </tbody>
      </table>
    </Card>
  );
}
