'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { usePortalSupabase } from '@/components/PortalProvider';
import { Button, Card, Input, Select } from '@/components/ui';

type VariantRow = {
  id: string;
  name: string;
  available_qty: number | null;
  track_availability: boolean;
  is_available: boolean;
  menu_items: { name: string } | { name: string }[] | null;
};

const SET_REASONS = [
  { value: 'prepared', label: 'Prepared a batch' },
  { value: 'recount', label: 'Recount' },
  { value: 'restock', label: 'Restock' },
  { value: 'closing', label: 'Closing count' },
  { value: 'out_of_stock', label: 'Out of stock' },
] as const;

function itemName(v: VariantRow): string {
  const m = Array.isArray(v.menu_items) ? v.menu_items[0] : v.menu_items;
  return m?.name ?? '—';
}

/**
 * Ready-to-serve portions per menu variant. Setting a count goes through
 * set_food_stock() (kitchen.manage_availability); recording waste goes
 * through record_waste() (kitchen.record_waste). Both are enforced in the
 * RPCs themselves — the props only decide which controls appear.
 */
export function FoodStockPanel({ canManage, canWaste }: { canManage: boolean; canWaste: boolean }) {
  const supabase = usePortalSupabase();
  const [rows, setRows] = useState<VariantRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [qty, setQty] = useState<Record<string, string>>({});
  const [reason, setReason] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    const { data, error: e } = await supabase
      .from('menu_variants')
      .select('id, name, available_qty, track_availability, is_available, menu_items(name)')
      .order('name');
    if (e) setError(e.message);
    else setRows((data ?? []) as unknown as VariantRow[]);
    setLoading(false);
  }, [supabase]);

  useEffect(() => {
    void load();
  }, [load]);

  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return rows
      .filter((r) => !q || `${itemName(r)} ${r.name}`.toLowerCase().includes(q))
      .sort((a, b) => itemName(a).localeCompare(itemName(b)) || a.name.localeCompare(b.name));
  }, [rows, filter]);

  async function act(id: string, fn: () => PromiseLike<{ error: { message: string } | null }>, ok: string) {
    setBusyId(id);
    setError(null);
    setNote(null);
    const { error: e } = await fn();
    setBusyId(null);
    if (e) {
      setError(e.message);
      return;
    }
    setNote(ok);
    setQty((q) => ({ ...q, [id]: '' }));
    await load();
  }

  function setCount(r: VariantRow) {
    const n = parseInt(qty[r.id] ?? '', 10);
    if (Number.isNaN(n) || n < 0) {
      setError('Enter a count of 0 or more.');
      return;
    }
    const why = reason[r.id] ?? 'prepared';
    void act(
      r.id,
      () => supabase.rpc('set_food_stock', { p_variant_id: r.id, p_new_qty: n, p_reason: why, p_note: null }),
      `${itemName(r)} · ${r.name} set to ${n}.`,
    );
  }

  function waste(r: VariantRow) {
    const v = window.prompt(`How many portions of ${itemName(r)} · ${r.name} were wasted?`, '1');
    if (v == null) return;
    const n = parseInt(v, 10);
    if (Number.isNaN(n) || n <= 0) {
      setError('Enter a positive number of portions.');
      return;
    }
    const why = window.prompt('Reason (e.g. burnt, dropped, expired):') ?? '';
    void act(
      r.id,
      () => supabase.rpc('record_waste', { p_variant_id: r.id, p_qty: n, p_reason: why, p_note: null }),
      `Recorded ${n} wasted.`,
    );
  }

  return (
    <Card className="p-0 overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-2 p-3 border-b border-border">
        <div>
          <h3 className="font-bold text-sm">Food availability</h3>
          <p className="text-muted text-[11px]">Ready-to-serve portions per item. Zero takes it off sale.</p>
        </div>
        <Input placeholder="Search items" value={filter} onChange={(e) => setFilter(e.target.value)} className="w-48" />
      </div>
      {error && <div className="bg-danger/10 text-danger text-xs p-3">{error}</div>}
      {note && <div className="bg-ok/10 text-ok text-xs p-3">{note}</div>}
      {loading ? (
        <p className="p-3 text-muted text-xs">Loading…</p>
      ) : shown.length === 0 ? (
        <p className="p-3 text-muted text-xs">No menu items found.</p>
      ) : (
        <div className="max-h-[28rem] overflow-y-auto">
          <table className="w-full text-left text-xs">
            <thead className="text-muted border-b border-border sticky top-0 bg-surface">
              <tr>
                <th className="p-2.5 font-semibold">Item</th>
                <th className="p-2.5 font-semibold text-right">Portions</th>
                <th className="p-2.5 font-semibold">On sale</th>
                <th className="p-2.5" />
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => (
                <tr key={r.id} className="border-b border-border/60 last:border-0 align-middle">
                  <td className="p-2.5">
                    <div className="font-semibold">{itemName(r)}</div>
                    <div className="text-muted">{r.name}</div>
                  </td>
                  <td className="p-2.5 text-right font-mono tabular-nums">
                    {r.track_availability ? (r.available_qty ?? 0) : '—'}
                  </td>
                  <td className="p-2.5">
                    <span className={r.is_available ? 'text-ok' : 'text-danger'}>{r.is_available ? 'yes' : 'no'}</span>
                  </td>
                  <td className="p-2.5">
                    <div className="flex flex-wrap items-center justify-end gap-1.5">
                      {canManage && (
                        <>
                          <Input
                            type="number"
                            min="0"
                            placeholder="Count"
                            value={qty[r.id] ?? ''}
                            onChange={(e) => setQty((q) => ({ ...q, [r.id]: e.target.value }))}
                            className="w-20"
                          />
                          <Select
                            value={reason[r.id] ?? 'prepared'}
                            onChange={(e) => setReason((m) => ({ ...m, [r.id]: e.target.value }))}
                            className="w-36"
                          >
                            {SET_REASONS.map((o) => (
                              <option key={o.value} value={o.value}>
                                {o.label}
                              </option>
                            ))}
                          </Select>
                          <Button disabled={busyId === r.id} onClick={() => setCount(r)}>
                            Set
                          </Button>
                        </>
                      )}
                      {canWaste && (
                        <Button variant="danger" disabled={busyId === r.id} onClick={() => waste(r)}>
                          Waste
                        </Button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
