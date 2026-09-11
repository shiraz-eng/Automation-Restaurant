'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { usePortalSupabase } from '@/components/PortalProvider';

type Line = {
  id: string;
  name_snapshot: string;
  qty: number;
  kds_status: 'queued' | 'preparing' | 'ready' | 'served';
  customer_note: string | null;
};
export type KOrder = {
  id: string;
  order_number: number;
  table_label: string | null;
  channel: string;
  status: string;
  customer_note: string | null;
  created_at: string;
  order_lines: Line[];
};
export type KVariant = {
  id: string;
  name: string;
  is_available: boolean;
  track_availability: boolean;
  available_qty: number;
  menu_items: { name: string } | null;
};

const ACTIVE = ['pending', 'in_kitchen', 'ready'];
type Lane = 'new' | 'preparing' | 'ready';

function laneOf(o: KOrder): Lane {
  if (
    o.status === 'ready' ||
    o.order_lines.every((l) => l.kds_status === 'ready' || l.kds_status === 'served')
  ) {
    return 'ready';
  }
  if (o.order_lines.some((l) => l.kds_status === 'preparing')) return 'preparing';
  return 'new';
}
function mins(iso: string) {
  return Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
}

export function KitchenPortalBoard({
  initialOrders,
  initialVariants,
  canAvailability,
  canWaste,
}: {
  initialOrders: KOrder[];
  initialVariants: KVariant[];
  canAvailability: boolean;
  canWaste: boolean;
}) {
  const router = useRouter();
  const supabase = usePortalSupabase();
  const [tab, setTab] = useState<'orders' | 'availability'>('orders');
  const [orders, setOrders] = useState<KOrder[]>(initialOrders);
  const [variants, setVariants] = useState<KVariant[]>(initialVariants);
  const [, tick] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const busy = useRef(false);

  const loadOrders = useCallback(async () => {
    const { data } = await supabase
      .from('orders')
      .select(
        'id, order_number, table_label, channel, status, customer_note, created_at, order_lines(id, name_snapshot, qty, kds_status, customer_note)',
      )
      .in('status', ACTIVE)
      .order('created_at', { ascending: true });
    if (data) setOrders(data as KOrder[]);
  }, [supabase]);

  const loadVariants = useCallback(async () => {
    const { data } = await supabase
      .from('menu_variants')
      .select('id, name, is_available, track_availability, available_qty, menu_items(name)')
      .order('name');
    if (data) setVariants(data as unknown as KVariant[]);
  }, [supabase]);

  useEffect(() => {
    const ch = supabase
      .channel('kitchen-portal')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'orders' }, () => loadOrders())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'order_lines' }, () => loadOrders())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'menu_variants' }, () => loadVariants())
      .subscribe();
    const clock = setInterval(() => tick((n) => n + 1), 20000);
    const poll = setInterval(loadOrders, 30000);
    return () => {
      supabase.removeChannel(ch);
      clearInterval(clock);
      clearInterval(poll);
    };
  }, [supabase, loadOrders, loadVariants]);

  async function act(fn: () => PromiseLike<{ error: { message: string } | null }>) {
    if (busy.current) return;
    busy.current = true;
    setError(null);
    const { error: e } = await fn();
    busy.current = false;
    if (e) setError(e.message);
    await loadOrders();
    router.refresh();
  }

  const lanes: { key: Lane; title: string; cta: string; rpc: (id: string) => PromiseLike<{ error: { message: string } | null }> }[] = [
    { key: 'new', title: 'New', cta: 'Start', rpc: (id) => supabase.rpc('kitchen_start_order', { p_order_id: id }) },
    { key: 'preparing', title: 'Preparing', cta: 'Mark ready', rpc: (id) => supabase.rpc('kitchen_mark_ready', { p_order_id: id }) },
    { key: 'ready', title: 'Ready', cta: 'Complete', rpc: (id) => supabase.rpc('kitchen_complete_order', { p_order_id: id }) },
  ];

  const byLane = useMemo(() => {
    const m: Record<Lane, KOrder[]> = { new: [], preparing: [], ready: [] };
    for (const o of orders) m[laneOf(o)].push(o);
    return m;
  }, [orders]);

  return (
    <div className="space-y-4">
      <div className="flex gap-2">
        {(['orders', 'availability'] as const).map((x) => (
          <button
            key={x}
            onClick={() => setTab(x)}
            className={`px-4 py-2 rounded font-bold text-sm capitalize ${
              tab === x ? 'bg-primary text-primary-fg' : 'border border-border'
            }`}
          >
            {x}
          </button>
        ))}
      </div>

      {error && <p className="text-danger text-sm">{error}</p>}

      {tab === 'orders' && (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          {lanes.map((lane) => (
            <section key={lane.key} className="rounded-lg border border-border bg-surface/50 p-3">
              <h2 className="font-black text-sm uppercase tracking-wider mb-3 flex justify-between">
                {lane.title}
                <span className="text-muted">{byLane[lane.key].length}</span>
              </h2>
              <div className="space-y-3">
                {byLane[lane.key].length === 0 ? (
                  <p className="text-muted text-xs">—</p>
                ) : (
                  byLane[lane.key].map((o) => {
                    const late = mins(o.created_at) >= 10;
                    return (
                      <div
                        key={o.id}
                        className={`rounded-lg border-2 bg-surface p-3 ${late ? 'border-danger' : 'border-border'}`}
                      >
                        <div className="flex items-baseline justify-between mb-2">
                          <span className="font-black text-lg">#{o.order_number}</span>
                          <span className="text-xs text-muted">
                            {o.table_label ?? o.channel.replace('_', ' ')} · {mins(o.created_at)}m
                          </span>
                        </div>
                        {o.customer_note && (
                          <p className="text-xs font-semibold text-warn mb-2">⚠ {o.customer_note}</p>
                        )}
                        <ul className="space-y-1.5 mb-3">
                          {o.order_lines.map((l) => (
                            <li key={l.id} className="text-sm">
                              <span className="font-semibold">
                                {l.qty}× {l.name_snapshot}
                              </span>
                              {l.customer_note && (
                                <span className="block text-xs text-warn">⚠ {l.customer_note}</span>
                              )}
                            </li>
                          ))}
                        </ul>
                        <button
                          onClick={() => act(() => lane.rpc(o.id))}
                          className="w-full rounded bg-primary text-primary-fg font-bold py-2.5 text-sm"
                        >
                          {lane.cta}
                        </button>
                      </div>
                    );
                  })
                )}
              </div>
            </section>
          ))}
        </div>
      )}

      {tab === 'availability' && (
        <div className="rounded-lg border border-border bg-surface divide-y divide-border">
          {variants.length === 0 ? (
            <p className="p-4 text-muted text-xs">No menu variants.</p>
          ) : (
            variants.map((v) => (
              <div key={v.id} className="p-3 flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="font-semibold text-sm truncate">
                    {v.menu_items?.name ?? '—'}
                    {v.name !== 'Regular' ? ` · ${v.name}` : ''}
                  </div>
                  <div className="text-xs text-muted">
                    {v.is_available ? (
                      v.track_availability ? `${v.available_qty} left` : 'available'
                    ) : (
                      <span className="text-danger font-semibold">out of stock</span>
                    )}
                  </div>
                </div>
                {canAvailability && (
                  <div className="flex gap-1.5 shrink-0 text-xs">
                    {canWaste && (
                      <button
                        onClick={() =>
                          act(() =>
                            supabase.rpc('record_waste', {
                              p_variant_id: v.id,
                              p_qty: 1,
                              p_reason: 'waste',
                              p_note: null,
                            }),
                          )
                        }
                        className="rounded border border-border px-2 py-1"
                      >
                        −1 waste
                      </button>
                    )}
                    <button
                      onClick={() => {
                        const n = window.prompt('Set remaining quantity:', String(v.available_qty));
                        if (n == null) return;
                        act(() =>
                          supabase.rpc('set_food_stock', {
                            p_variant_id: v.id,
                            p_new_qty: Math.max(0, parseInt(n, 10) || 0),
                            p_reason: 'recount',
                            p_note: null,
                          }),
                        );
                      }}
                      className="rounded border border-border px-2 py-1"
                    >
                      Set qty
                    </button>
                    <button
                      onClick={() =>
                        act(() =>
                          supabase.rpc('set_variant_available', {
                            p_variant_id: v.id,
                            p_available: !v.is_available,
                            p_reason: v.is_available ? 'kitchen' : 'kitchen',
                          }),
                        )
                      }
                      className={`rounded px-2 py-1 font-semibold ${
                        v.is_available ? 'border border-danger text-danger' : 'bg-primary text-primary-fg'
                      }`}
                    >
                      {v.is_available ? 'Out of stock' : 'Back in'}
                    </button>
                  </div>
                )}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
