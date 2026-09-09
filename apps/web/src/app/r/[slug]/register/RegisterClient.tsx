'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { usePortalSupabase } from '@/components/PortalProvider';
import { formatCents } from '@/lib/format';

type Line = { name_snapshot: string; qty: number; line_total_cents: number };
export type Bill = {
  id: string;
  order_number: number;
  session_id: string | null;
  table_label: string | null;
  customer_name: string | null;
  status: string;
  subtotal_cents: number;
  tax_cents: number;
  total_cents: number;
  created_at: string;
  order_lines: Line[];
};

const UNPAID = ['pending', 'in_kitchen', 'ready', 'served'];
const METHODS = ['cash', 'card', 'mobile'] as const;

type Group = {
  key: string;
  sessionId: string | null;
  tableLabel: string | null;
  orders: Bill[];
  subtotal: number;
  tax: number;
  total: number;
};

function group(bills: Bill[]): Group[] {
  const map = new Map<string, Group>();
  for (const b of bills) {
    const key = b.session_id ?? `order:${b.id}`;
    const g =
      map.get(key) ??
      ({
        key,
        sessionId: b.session_id,
        tableLabel: b.table_label,
        orders: [],
        subtotal: 0,
        tax: 0,
        total: 0,
      } as Group);
    g.orders.push(b);
    g.subtotal += b.subtotal_cents;
    g.tax += b.tax_cents;
    g.total += b.total_cents;
    map.set(key, g);
  }
  return [...map.values()];
}

export function RegisterClient({ initial }: { initial: Bill[] }) {
  const supabase = usePortalSupabase();
  const [bills, setBills] = useState<Bill[]>(initial);
  const [method, setMethod] = useState<Record<string, (typeof METHODS)[number]>>({});
  const [tendered, setTendered] = useState<Record<string, string>>({});
  const [busyKey, setBusyKey] = useState<string | null>(null);

  const load = useCallback(async () => {
    const { data } = await supabase
      .from('orders')
      .select(
        'id, order_number, session_id, table_label, customer_name, status, subtotal_cents, tax_cents, total_cents, created_at, order_lines(name_snapshot, qty, line_total_cents)',
      )
      .in('status', UNPAID)
      .order('created_at', { ascending: true });
    if (data) setBills(data as Bill[]);
  }, [supabase]);

  useEffect(() => {
    const ch = supabase
      .channel('register-orders')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'orders' }, () => load())
      .subscribe();
    return () => {
      supabase.removeChannel(ch);
    };
  }, [supabase, load]);

  const groups = useMemo(() => group(bills), [bills]);

  async function takePayment(g: Group) {
    const m = method[g.key] ?? 'cash';
    setBusyKey(g.key);
    setBills((bs) => bs.filter((b) => !g.orders.some((o) => o.id === b.id)));
    if (g.sessionId) {
      await supabase.rpc('close_session', { p_session_id: g.sessionId, p_payment_method: m });
    } else {
      await supabase
        .from('orders')
        .update({ status: 'paid', payment_method: m, paid_at: new Date().toISOString() })
        .in(
          'id',
          g.orders.map((o) => o.id),
        );
    }
    setBusyKey(null);
    load();
  }

  if (groups.length === 0) {
    return (
      <div className="rounded-lg border border-border bg-surface p-10 text-center text-muted text-sm">
        No open bills.
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3">
      {groups.map((g) => {
        const m = method[g.key] ?? 'cash';
        const cash = parseFloat(tendered[g.key] ?? '');
        const change = m === 'cash' && !Number.isNaN(cash) ? cash * 100 - g.total : null;
        const lines = g.orders.flatMap((o) => o.order_lines);
        return (
          <div key={g.key} className="rounded-lg border border-border bg-surface p-4">
            <div className="flex items-baseline justify-between mb-2">
              <span className="font-black">
                {g.tableLabel ?? `#${g.orders[0].order_number}`}
              </span>
              <span className="text-xs text-muted">
                {g.sessionId ? 'table session · ' : ''}
                {g.orders.map((o) => `#${o.order_number}`).join(' ')}
              </span>
            </div>
            <div className="space-y-0.5 text-xs mb-2">
              {lines.map((l, i) => (
                <div key={i} className="flex justify-between">
                  <span>
                    {l.qty}× {l.name_snapshot}
                  </span>
                  <span>{formatCents(l.line_total_cents)}</span>
                </div>
              ))}
            </div>
            <div className="text-xs text-muted flex justify-between border-t border-border pt-1">
              <span>tax {formatCents(g.tax)}</span>
              <span className="text-body font-black text-sm">{formatCents(g.total)}</span>
            </div>

            <div className="flex gap-1.5 mt-3">
              {METHODS.map((x) => (
                <button
                  key={x}
                  onClick={() => setMethod((s) => ({ ...s, [g.key]: x }))}
                  className={`flex-1 rounded py-1.5 text-xs font-semibold capitalize ${
                    m === x ? 'bg-primary text-primary-fg' : 'border border-border'
                  }`}
                >
                  {x}
                </button>
              ))}
            </div>

            {m === 'cash' && (
              <div className="mt-2 flex items-center gap-2 text-xs">
                <input
                  type="number"
                  step="0.01"
                  placeholder="Cash tendered"
                  value={tendered[g.key] ?? ''}
                  onChange={(e) => setTendered((s) => ({ ...s, [g.key]: e.target.value }))}
                  className="flex-1 rounded border border-border bg-main px-2 py-1.5 outline-none"
                />
                {change !== null && (
                  <span className={`font-bold ${change < 0 ? 'text-danger' : 'text-ok'}`}>
                    {change < 0 ? 'short ' : 'change '}
                    {formatCents(Math.abs(change))}
                  </span>
                )}
              </div>
            )}

            <button
              onClick={() => takePayment(g)}
              disabled={busyKey === g.key || (m === 'cash' && (change ?? -1) < 0)}
              className="w-full mt-3 rounded bg-primary text-primary-fg font-bold py-2.5 text-sm disabled:opacity-50"
            >
              {g.sessionId ? 'Close table & take payment' : 'Take payment'}
            </button>
          </div>
        );
      })}
    </div>
  );
}
