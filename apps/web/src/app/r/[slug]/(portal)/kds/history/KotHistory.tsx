'use client';

import { useMemo, useState } from 'react';
import { Search } from 'lucide-react';
import { formatDateTime } from '@/lib/format';
import { orderTypeLabel, tableNumberLabel } from '../kitchenTypes';

type Line = { id: string; name_snapshot: string; qty: number; kds_status: string; menu_item_id: string | null; menu_items: { station: string | null } | { station: string | null }[] | null };
export type HistoryRow = {
  id: string;
  order_number: number;
  table_label: string | null;
  channel: string;
  created_at: string;
  status: string;
  order_lines: Line[];
};
export type AuditRow = { entity_id: string; action: string; created_at: string };

function one<T>(x: T | T[] | null): T | null {
  return Array.isArray(x) ? (x[0] ?? null) : x;
}

const STATUS_LABEL: Record<string, string> = { served: 'Served', paid: 'Paid', void: 'Cancelled' };
const STATUS_TONE: Record<string, string> = { served: 'text-ok', paid: 'text-ok', void: 'text-danger' };

export function KotHistory({ rows, auditRows }: { rows: HistoryRow[]; auditRows: AuditRow[] }) {
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('all');
  const [station, setStation] = useState('all');
  const [channel, setChannel] = useState('all');
  const [date, setDate] = useState('');

  const eventsByOrder = useMemo(() => {
    const map = new Map<string, Record<string, string>>();
    for (const a of auditRows) {
      const cur = map.get(a.entity_id) ?? {};
      cur[a.action] = a.created_at;
      map.set(a.entity_id, cur);
    }
    return map;
  }, [auditRows]);

  const stations = useMemo(() => {
    const set = new Set<string>();
    for (const r of rows) for (const l of r.order_lines) set.add(one(l.menu_items)?.station?.trim() || 'Unassigned');
    return [...set].sort();
  }, [rows]);
  const channels = useMemo(() => [...new Set(rows.map((r) => r.channel))].sort(), [rows]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter((r) => {
      if (status !== 'all' && r.status !== status) return false;
      if (channel !== 'all' && r.channel !== channel) return false;
      if (date && !r.created_at.startsWith(date)) return false;
      if (station !== 'all') {
        const rowStations = r.order_lines.map((l) => one(l.menu_items)?.station?.trim() || 'Unassigned');
        if (!rowStations.includes(station)) return false;
      }
      if (q) {
        const hay = `${r.order_number} ${r.table_label ?? ''} ${r.order_lines.map((l) => l.name_snapshot).join(' ')}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [rows, search, status, station, channel, date]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[180px]">
          <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search order #, table, item..."
            className="w-full rounded-lg border border-border bg-surface pl-8 pr-3 py-2 text-xs outline-none focus:border-primary"
          />
        </div>
        <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="rounded-lg border border-border bg-surface px-2.5 py-2 text-xs outline-none focus:border-primary" />
        <select value={status} onChange={(e) => setStatus(e.target.value)} className="rounded-lg border border-border bg-surface px-2.5 py-2 text-xs outline-none focus:border-primary">
          <option value="all">All status</option>
          <option value="served">Served</option>
          <option value="paid">Paid</option>
          <option value="void">Cancelled</option>
        </select>
        <select value={channel} onChange={(e) => setChannel(e.target.value)} className="rounded-lg border border-border bg-surface px-2.5 py-2 text-xs outline-none focus:border-primary">
          <option value="all">All order types</option>
          {channels.map((c) => (
            <option key={c} value={c}>
              {orderTypeLabel(c)}
            </option>
          ))}
        </select>
        {stations.length > 0 && (
          <select value={station} onChange={(e) => setStation(e.target.value)} className="rounded-lg border border-border bg-surface px-2.5 py-2 text-xs outline-none focus:border-primary">
            <option value="all">All stations</option>
            {stations.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        )}
      </div>

      <div className="rounded-lg border border-border bg-surface overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs border-collapse">
            <thead>
              <tr className="border-b border-border text-muted">
                <th className="p-3 font-semibold">KOT</th>
                <th className="p-3 font-semibold">Table / Type</th>
                <th className="p-3 font-semibold">Items</th>
                <th className="p-3 font-semibold hidden md:table-cell">Station</th>
                <th className="p-3 font-semibold hidden lg:table-cell">Started</th>
                <th className="p-3 font-semibold hidden lg:table-cell">Ready</th>
                <th className="p-3 font-semibold hidden lg:table-cell">Completed</th>
                <th className="p-3 font-semibold">Status</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((r) => {
                const ev = eventsByOrder.get(r.id) ?? {};
                const rowStations = [...new Set(r.order_lines.map((l) => one(l.menu_items)?.station?.trim() || 'Unassigned'))];
                return (
                  <tr key={r.id} className="border-b border-border/60 last:border-0">
                    <td className="p-3 font-bold">#{r.order_number}</td>
                    <td className="p-3 text-muted">
                      {r.table_label ? `Table ${tableNumberLabel(r.table_label)}` : '—'} · {orderTypeLabel(r.channel)}
                    </td>
                    <td className="p-3 text-muted max-w-[220px] truncate">{r.order_lines.map((l) => `${l.qty}× ${l.name_snapshot}`).join(', ')}</td>
                    <td className="p-3 hidden md:table-cell text-muted">{rowStations.length > 1 ? 'Multiple' : rowStations[0]}</td>
                    <td className="p-3 hidden lg:table-cell text-muted">{ev['kitchen.start'] ? formatDateTime(ev['kitchen.start']) : '—'}</td>
                    <td className="p-3 hidden lg:table-cell text-muted">{ev['kitchen.ready'] ? formatDateTime(ev['kitchen.ready']) : '—'}</td>
                    <td className="p-3 hidden lg:table-cell text-muted">{ev['kitchen.complete'] ? formatDateTime(ev['kitchen.complete']) : '—'}</td>
                    <td className={`p-3 font-semibold ${STATUS_TONE[r.status] ?? ''}`}>{STATUS_LABEL[r.status] ?? r.status}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {filtered.length === 0 && <p className="text-muted text-xs p-6 text-center">No tickets match these filters.</p>}
      </div>
    </div>
  );
}
