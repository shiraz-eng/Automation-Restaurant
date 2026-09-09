'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { usePortalSupabase } from '@/components/PortalProvider';
import { StatCard } from '@/components/StatCard';
import { Card } from '@/components/ui';
import { formatCents, formatDateTime } from '@/lib/format';

export type LiveOrder = {
  id: string;
  order_number: number;
  table_label: string | null;
  status: string;
  total_cents: number;
  created_at: string;
};
export type FeedbackRow = {
  id: string;
  guest_name: string | null;
  table_label: string | null;
  overall: number;
  comment: string | null;
  created_at: string;
};

const ACTIVE = ['pending', 'in_kitchen', 'ready'];
const STATUS_LABEL: Record<string, string> = {
  pending: 'New',
  in_kitchen: 'Preparing',
  ready: 'Ready',
  served: 'Served',
  paid: 'Paid',
  void: 'Void',
};

export function LiveBoard({
  initialOrders,
  initialFeedback,
}: {
  initialOrders: LiveOrder[];
  initialFeedback: FeedbackRow[];
}) {
  const supabase = usePortalSupabase();
  const [orders, setOrders] = useState<LiveOrder[]>(initialOrders);
  const [feedback, setFeedback] = useState<FeedbackRow[]>(initialFeedback);

  const since = useMemo(() => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d.toISOString();
  }, []);

  const reload = useCallback(async () => {
    const [o, f] = await Promise.all([
      supabase
        .from('orders')
        .select('id, order_number, table_label, status, total_cents, created_at')
        .gte('created_at', since)
        .order('created_at', { ascending: false })
        .limit(100),
      supabase
        .from('feedback')
        .select('id, guest_name, table_label, overall, comment, created_at')
        .order('created_at', { ascending: false })
        .limit(20),
    ]);
    if (o.data) setOrders(o.data as LiveOrder[]);
    if (f.data) setFeedback(f.data as FeedbackRow[]);
  }, [supabase, since]);

  useEffect(() => {
    const ch = supabase
      .channel('live-ops')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'orders' }, () => reload())
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'feedback' }, () => reload())
      .subscribe();
    return () => {
      supabase.removeChannel(ch);
    };
  }, [supabase, reload]);

  const counts = orders.reduce<Record<string, number>>((acc, o) => {
    acc[o.status] = (acc[o.status] ?? 0) + 1;
    return acc;
  }, {});
  const newCount = counts.pending ?? 0;
  const preparing = counts.in_kitchen ?? 0;
  const ready = counts.ready ?? 0;
  const servedToday = (counts.served ?? 0) + (counts.paid ?? 0);

  const activeTables = [
    ...new Set(orders.filter((o) => ACTIVE.includes(o.status)).map((o) => o.table_label ?? '—')),
  ];

  const avg =
    feedback.length > 0
      ? (feedback.reduce((s, f) => s + f.overall, 0) / feedback.length).toFixed(1)
      : '—';
  const negatives = feedback.filter((f) => f.overall <= 2);

  return (
    <div className="space-y-6">
      <section className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard label="New" value={newCount} tone={newCount ? 'warn' : 'default'} />
        <StatCard label="Preparing" value={preparing} tone={preparing ? 'warn' : 'default'} />
        <StatCard label="Ready" value={ready} tone={ready ? 'ok' : 'default'} />
        <StatCard label="Served today" value={servedToday} />
      </section>

      <div className="grid lg:grid-cols-3 gap-6">
        <Card className="lg:col-span-2">
          <h2 className="font-bold text-sm mb-3">Activity feed</h2>
          {orders.length === 0 ? (
            <p className="text-muted text-xs">Nothing today yet.</p>
          ) : (
            <ul className="space-y-1.5 text-xs max-h-80 overflow-y-auto">
              {orders.slice(0, 40).map((o) => (
                <li key={o.id} className="flex items-center justify-between">
                  <span>
                    <span className="text-muted">{formatDateTime(o.created_at)} · </span>
                    <span className="font-mono font-bold">#{o.order_number}</span>{' '}
                    {o.table_label ?? 'order'} —{' '}
                    <span className="font-semibold">{STATUS_LABEL[o.status] ?? o.status}</span>
                  </span>
                  <span className="text-muted">{formatCents(o.total_cents)}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card>
          <h2 className="font-bold text-sm mb-3">Live tables</h2>
          {activeTables.length === 0 ? (
            <p className="text-muted text-xs">No open tables.</p>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {activeTables.map((tbl) => (
                <span
                  key={tbl}
                  className="rounded border border-warn/40 text-warn text-xs font-semibold px-2 py-1"
                >
                  {tbl}
                </span>
              ))}
            </div>
          )}
        </Card>
      </div>

      <Card>
        <div className="flex items-baseline justify-between mb-3">
          <h2 className="font-bold text-sm">Guest feedback</h2>
          <span className="text-xs text-muted">
            avg <span className="text-body font-bold">{avg}</span> · {feedback.length} recent
          </span>
        </div>
        {negatives.length > 0 && (
          <div className="mb-3 rounded border border-danger/40 bg-danger/10 text-danger text-xs p-2">
            {negatives.length} low rating{negatives.length === 1 ? '' : 's'} — needs attention
          </div>
        )}
        {feedback.length === 0 ? (
          <p className="text-muted text-xs">No feedback yet.</p>
        ) : (
          <ul className="space-y-2 text-xs">
            {feedback.map((f) => (
              <li
                key={f.id}
                className={`rounded border p-2 ${
                  f.overall <= 2 ? 'border-danger/40' : 'border-border'
                }`}
              >
                <div className="flex items-center justify-between">
                  <span className="font-semibold">
                    {'★'.repeat(f.overall)}
                    <span className="text-muted">{'★'.repeat(5 - f.overall)}</span>
                  </span>
                  <span className="text-muted">
                    {f.guest_name ?? 'Guest'}
                    {f.table_label ? ` · ${f.table_label}` : ''} · {formatDateTime(f.created_at)}
                  </span>
                </div>
                {f.comment && <p className="text-muted mt-1">{f.comment}</p>}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
