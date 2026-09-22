'use client';

import { useMemo, useState } from 'react';
import { Search } from 'lucide-react';
import { formatDateTime } from '@/lib/format';

type Ref<T> = T | T[] | null;
function one<T>(x: Ref<T>): T | null {
  return Array.isArray(x) ? (x[0] ?? null) : x;
}

export type AvailabilityHistoryRow = {
  id: number;
  menu_item_id: string;
  variant_id: string | null;
  previous_status: string | null;
  new_status: string;
  previous_producible_qty: number | null;
  new_producible_qty: number | null;
  bottleneck_inventory_item_id: string | null;
  reason: string | null;
  trigger_type: string;
  trigger_reference: string | null;
  actor: string;
  created_at: string;
  menu_items: Ref<{ name: string }>;
  menu_variants: Ref<{ name: string }>;
  inventory_items: Ref<{ name: string }>;
};

const STATUS_LABEL: Record<string, string> = { available: 'Available', low_stock: 'Low Stock', unavailable: 'Unavailable' };
const STATUS_TONE: Record<string, string> = { available: 'text-ok', low_stock: 'text-warn', unavailable: 'text-danger' };
const TRIGGER_LABEL: Record<string, string> = {
  inventory_consumption: 'Order consumed stock',
  inventory_restock: 'Restock',
  recipe_change: 'Recipe changed',
  manual_recalculation: 'Manual recalculation',
  priority_reallocation: 'Priority allocation',
  priority_change: 'Priority list changed',
};

/** Availability History / Audit — the recipe-driven availability engine's
 *  own immutable transition log (availability_audit_log, tenant-migrations
 *  /0052), one row per real status/producible-qty change the engine
 *  recorded, never recomputed here. */
export function AvailabilityHistory({ rows }: { rows: AvailabilityHistoryRow[] }) {
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('all');
  const [trigger, setTrigger] = useState('all');
  const [actor, setActor] = useState('all');
  const [date, setDate] = useState('');

  const actors = useMemo(() => [...new Set(rows.map((r) => r.actor))].sort(), [rows]);
  const triggers = useMemo(() => [...new Set(rows.map((r) => r.trigger_type))].sort(), [rows]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter((r) => {
      if (status !== 'all' && r.new_status !== status) return false;
      if (trigger !== 'all' && r.trigger_type !== trigger) return false;
      if (actor !== 'all' && r.actor !== actor) return false;
      if (date && !r.created_at.startsWith(date)) return false;
      if (q) {
        const hay = `${one(r.menu_items)?.name ?? ''} ${one(r.menu_variants)?.name ?? ''} ${one(r.inventory_items)?.name ?? ''} ${r.reason ?? ''}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [rows, search, status, trigger, actor, date]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[220px]">
          <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search product, ingredient, reason…"
            className="w-full rounded-lg border border-border bg-surface pl-8 pr-3 py-2 text-xs outline-none focus:border-primary"
          />
        </div>
        <input
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
          className="rounded-lg border border-border bg-surface px-2.5 py-2 text-xs outline-none focus:border-primary"
        />
        <select value={status} onChange={(e) => setStatus(e.target.value)} className="rounded-lg border border-border bg-surface px-2.5 py-2 text-xs outline-none focus:border-primary">
          <option value="all">All statuses</option>
          <option value="available">Available</option>
          <option value="low_stock">Low Stock</option>
          <option value="unavailable">Unavailable</option>
        </select>
        {triggers.length > 0 && (
          <select value={trigger} onChange={(e) => setTrigger(e.target.value)} className="rounded-lg border border-border bg-surface px-2.5 py-2 text-xs outline-none focus:border-primary">
            <option value="all">All triggers</option>
            {triggers.map((t) => (
              <option key={t} value={t}>
                {TRIGGER_LABEL[t] ?? t}
              </option>
            ))}
          </select>
        )}
        {actors.length > 1 && (
          <select value={actor} onChange={(e) => setActor(e.target.value)} className="rounded-lg border border-border bg-surface px-2.5 py-2 text-xs outline-none focus:border-primary">
            <option value="all">All actors</option>
            {actors.map((a) => (
              <option key={a} value={a}>
                {a}
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
                <th className="p-3 font-semibold">Time</th>
                <th className="p-3 font-semibold">Product</th>
                <th className="p-3 font-semibold">Change</th>
                <th className="p-3 font-semibold">Qty</th>
                <th className="p-3 font-semibold">Reason</th>
                <th className="p-3 font-semibold hidden md:table-cell">Ingredient</th>
                <th className="p-3 font-semibold hidden lg:table-cell">Trigger</th>
                <th className="p-3 font-semibold hidden lg:table-cell">Actor</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((r) => {
                const productName = one(r.menu_items)?.name ?? '—';
                const variantName = one(r.menu_variants)?.name;
                const ingredientName = one(r.inventory_items)?.name ?? '—';
                return (
                  <tr key={r.id} className="border-b border-border/60 last:border-0">
                    <td className="p-3 text-muted whitespace-nowrap">{formatDateTime(r.created_at)}</td>
                    <td className="p-3 font-semibold">
                      {productName}
                      {variantName ? ` · ${variantName}` : ''}
                    </td>
                    <td className="p-3 whitespace-nowrap">
                      <span className={STATUS_TONE[r.previous_status ?? ''] ?? 'text-muted'}>
                        {r.previous_status ? (STATUS_LABEL[r.previous_status] ?? r.previous_status) : 'new'}
                      </span>
                      <span className="text-muted mx-1">→</span>
                      <span className={STATUS_TONE[r.new_status] ?? ''}>{STATUS_LABEL[r.new_status] ?? r.new_status}</span>
                    </td>
                    <td className="p-3 font-mono text-muted whitespace-nowrap">
                      {r.previous_producible_qty ?? '—'} → {r.new_producible_qty ?? '—'}
                    </td>
                    <td className="p-3 text-muted max-w-[220px] truncate">{r.reason ?? '—'}</td>
                    <td className="p-3 hidden md:table-cell text-muted">{ingredientName}</td>
                    <td className="p-3 hidden lg:table-cell text-muted">{TRIGGER_LABEL[r.trigger_type] ?? r.trigger_type}</td>
                    <td className="p-3 hidden lg:table-cell text-muted capitalize">{r.actor}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {filtered.length === 0 && <p className="text-muted text-xs p-6 text-center">No availability changes match these filters.</p>}
      </div>
    </div>
  );
}
