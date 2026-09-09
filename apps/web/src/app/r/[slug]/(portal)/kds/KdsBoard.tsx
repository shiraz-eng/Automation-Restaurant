'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { usePortalSupabase } from '@/components/PortalProvider';
import { Button } from '@/components/ui';

type Line = {
  id: string;
  name_snapshot: string;
  qty: number;
  kds_status: 'queued' | 'preparing' | 'ready' | 'served';
  modifiers: unknown;
};
export type Ticket = {
  id: string;
  order_number: number;
  table_label: string | null;
  channel: string;
  created_at: string;
  status: string;
  order_lines: Line[];
};

const ACTIVE = ['pending', 'in_kitchen', 'ready'];
const NEXT: Record<Line['kds_status'], Line['kds_status'] | null> = {
  queued: 'preparing',
  preparing: 'ready',
  ready: 'served',
  served: null,
};
const POLL_MS = 4000;

function ageMinutes(iso: string) {
  return (Date.now() - new Date(iso).getTime()) / 60000;
}
function urgency(iso: string) {
  const m = ageMinutes(iso);
  if (m >= 10) return 'border-danger';
  if (m >= 5) return 'border-warn';
  return 'border-ok';
}

export function KdsBoard({ initial }: { initial: Ticket[] }) {
  const supabase = usePortalSupabase();
  const [tickets, setTickets] = useState<Ticket[]>(initial);
  const [, forceTick] = useState(0);
  const busy = useRef<Set<string>>(new Set());

  const load = useCallback(async () => {
    const { data } = await supabase
      .from('orders')
      .select(
        'id, order_number, table_label, channel, created_at, status, order_lines(id, name_snapshot, qty, kds_status, modifiers)',
      )
      .in('status', ACTIVE)
      .order('created_at', { ascending: true });
    if (data) setTickets(data as Ticket[]);
  }, [supabase]);

  useEffect(() => {
    const poll = setInterval(load, POLL_MS);
    const clock = setInterval(() => forceTick((n) => n + 1), 15000);
    return () => {
      clearInterval(poll);
      clearInterval(clock);
    };
  }, [load]);

  async function advanceLine(line: Line) {
    const next = NEXT[line.kds_status];
    if (!next || busy.current.has(line.id)) return;
    busy.current.add(line.id);
    setTickets((ts) =>
      ts.map((t) => ({
        ...t,
        order_lines: t.order_lines.map((l) =>
          l.id === line.id ? { ...l, kds_status: next } : l,
        ),
      })),
    );
    await supabase.from('order_lines').update({ kds_status: next }).eq('id', line.id);
    busy.current.delete(line.id);
    load();
  }

  async function bump(ticket: Ticket) {
    setTickets((ts) => ts.filter((t) => t.id !== ticket.id));
    await supabase.from('orders').update({ status: 'served' }).eq('id', ticket.id);
    load();
  }

  if (tickets.length === 0) {
    return (
      <div className="rounded-lg border border-border bg-surface p-10 text-center text-muted text-sm">
        No active tickets. New orders appear here automatically.
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3">
      {tickets.map((t) => {
        const allReady = t.order_lines.every(
          (l) => l.kds_status === 'ready' || l.kds_status === 'served',
        );
        return (
          <div key={t.id} className={`rounded-lg border-2 ${urgency(t.created_at)} bg-surface p-4`}>
            <div className="flex items-baseline justify-between mb-3">
              <span className="font-black">#{t.order_number}</span>
              <span className="text-xs text-muted">
                {t.table_label ?? t.channel.replace('_', ' ')} ·{' '}
                {Math.floor(ageMinutes(t.created_at))}m
              </span>
            </div>

            <div className="space-y-1.5">
              {t.order_lines.map((l) => {
                const done = l.kds_status === 'served';
                return (
                  <button
                    key={l.id}
                    onClick={() => advanceLine(l)}
                    disabled={done}
                    className={`w-full flex items-center justify-between rounded border border-border px-2.5 py-1.5 text-xs text-left ${
                      done ? 'opacity-40 line-through' : 'hover:border-primary'
                    }`}
                  >
                    <span>
                      {l.qty}× {l.name_snapshot}
                    </span>
                    <span
                      className={`font-semibold ${
                        l.kds_status === 'ready'
                          ? 'text-ok'
                          : l.kds_status === 'preparing'
                            ? 'text-warn'
                            : 'text-muted'
                      }`}
                    >
                      {l.kds_status}
                    </span>
                  </button>
                );
              })}
            </div>

            <Button
              variant={allReady ? 'primary' : 'ghost'}
              className="w-full mt-3"
              onClick={() => bump(t)}
            >
              {allReady ? 'Bump — all ready' : 'Bump anyway'}
            </Button>
          </div>
        );
      })}
    </div>
  );
}
