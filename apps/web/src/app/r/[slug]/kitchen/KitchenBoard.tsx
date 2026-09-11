'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { usePortalSupabase } from '@/components/PortalProvider';

type ModSnapshot = { id: string; name: string; price_cents: number };
type Line = {
  id: string;
  name_snapshot: string;
  qty: number;
  kds_status: 'queued' | 'preparing' | 'ready' | 'served';
  modifiers: ModSnapshot[] | null;
  customer_note: string | null;
};
export type KitchenTicket = {
  id: string;
  order_number: number;
  table_label: string | null;
  customer_name: string | null;
  channel: string;
  created_at: string;
  status: string;
  customer_note: string | null;
  order_lines: Line[];
};

const ACTIVE = ['pending', 'in_kitchen', 'ready'];
const POLL_MS = 3000;

type Lane = 'new' | 'preparing' | 'ready';

function laneOf(t: KitchenTicket): Lane {
  if (t.status === 'ready' || t.order_lines.every((l) => l.kds_status === 'ready' || l.kds_status === 'served')) {
    return 'ready';
  }
  if (t.order_lines.some((l) => l.kds_status === 'preparing')) return 'preparing';
  return 'new';
}

function mins(iso: string) {
  return Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
}

export function KitchenBoard({ initial }: { initial: KitchenTicket[] }) {
  const supabase = usePortalSupabase();
  const [tickets, setTickets] = useState<KitchenTicket[]>(initial);
  const [, tick] = useState(0);
  const busy = useRef(false);

  const load = useCallback(async () => {
    const { data } = await supabase
      .from('orders')
      .select(
        'id, order_number, table_label, customer_name, channel, created_at, status, customer_note, order_lines(id, name_snapshot, qty, kds_status, modifiers, customer_note)',
      )
      .in('status', ACTIVE)
      .order('created_at', { ascending: true });
    if (data) setTickets(data as KitchenTicket[]);
  }, [supabase]);

  useEffect(() => {
    const p = setInterval(load, POLL_MS);
    const c = setInterval(() => tick((n) => n + 1), 20000);
    return () => {
      clearInterval(p);
      clearInterval(c);
    };
  }, [load]);

  async function advance(
    ticket: KitchenTicket,
    rpc: 'kitchen_start_order' | 'kitchen_mark_ready' | 'kitchen_complete_order',
  ) {
    if (busy.current) return;
    busy.current = true;
    if (rpc === 'kitchen_complete_order') {
      setTickets((ts) => ts.filter((t) => t.id !== ticket.id));
    }
    await supabase.rpc(rpc, { p_order_id: ticket.id });
    busy.current = false;
    load();
  }

  const lanes: { key: Lane; title: string; action?: (t: KitchenTicket) => void; cta?: string }[] = [
    { key: 'new', title: 'New', action: (t) => advance(t, 'kitchen_start_order'), cta: 'Start' },
    { key: 'preparing', title: 'Preparing', action: (t) => advance(t, 'kitchen_mark_ready'), cta: 'Mark ready' },
    { key: 'ready', title: 'Ready', action: (t) => advance(t, 'kitchen_complete_order'), cta: 'Complete' },
  ];

  return (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-3 h-full">
      {lanes.map((lane) => {
        const items = tickets.filter((t) => laneOf(t) === lane.key);
        return (
          <section
            key={lane.key}
            className="rounded-lg border border-border bg-surface/50 p-3 flex flex-col min-h-0"
          >
            <h2 className="font-black text-sm uppercase tracking-wider mb-3 flex items-center justify-between">
              {lane.title}
              <span className="text-muted">{items.length}</span>
            </h2>
            <div className="flex-1 overflow-y-auto space-y-3">
              {items.length === 0 ? (
                <p className="text-muted text-xs">—</p>
              ) : (
                items.map((t) => {
                  const late = mins(t.created_at) >= 10;
                  return (
                    <div
                      key={t.id}
                      className={`rounded-lg border-2 bg-surface p-3 ${
                        late ? 'border-danger' : 'border-border'
                      }`}
                    >
                      <div className="flex items-baseline justify-between mb-2">
                        <span className="font-black text-lg">#{t.order_number}</span>
                        <span className="text-xs text-muted">
                          {t.table_label ?? t.channel.replace('_', ' ')} · {mins(t.created_at)}m
                        </span>
                      </div>
                      {t.customer_name && (
                        <div className="text-xs text-muted mb-1">{t.customer_name}</div>
                      )}
                      {t.customer_note && (
                        <p className="text-xs font-semibold text-warn mb-1">⚠ {t.customer_note}</p>
                      )}
                      <ul className="space-y-1 mb-3">
                        {t.order_lines.map((l) => (
                          <li key={l.id} className="text-sm font-semibold">
                            {l.qty}× {l.name_snapshot}
                            {l.modifiers && l.modifiers.length > 0 && (
                              <span className="block text-xs font-normal text-muted">
                                {l.modifiers.map((m) => m.name).join(', ')}
                              </span>
                            )}
                            {l.customer_note && (
                              <span className="block text-xs font-normal text-warn">
                                ⚠ {l.customer_note}
                              </span>
                            )}
                          </li>
                        ))}
                      </ul>
                      {lane.action && (
                        <button
                          onClick={() => lane.action!(t)}
                          className="w-full rounded bg-primary text-primary-fg font-bold py-2.5 text-sm"
                        >
                          {lane.cta}
                        </button>
                      )}
                    </div>
                  );
                })
              )}
            </div>
          </section>
        );
      })}
    </div>
  );
}
