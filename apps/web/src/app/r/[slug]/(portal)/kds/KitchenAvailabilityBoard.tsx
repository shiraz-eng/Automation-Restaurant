'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { usePortalSupabase } from '@/components/PortalProvider';
import { Button, Card, Input } from '@/components/ui';

type Row = {
  menu_item_id: string;
  variant_id: string | null;
  status: 'available' | 'low_stock' | 'unavailable';
  producible_qty: number | null;
  reason: string | null;
  updated_at: string;
};
type ItemInfo = { id: string; name: string; is_available: boolean };
type VariantInfo = { id: string; name: string; is_available: boolean };

const STATUS: Record<Row['status'], { label: string; tone: string }> = {
  available: { label: 'Available', tone: 'text-ok' },
  low_stock: { label: 'Low stock', tone: 'text-warn' },
  unavailable: { label: 'Unavailable', tone: 'text-danger' },
};

/**
 * Food availability as the backend computed it (product_availability —
 * recipe × inventory, then priority allocation). This board never
 * calculates a number itself; it reads the authoritative rows and reloads
 * whenever they change (realtime on product_availability), so it always
 * matches the Menu, POS and customer menu.
 *
 * canWaste (kitchen.record_waste): record_dish_waste() deducts the dish's
 * recipe ingredients from inventory, which recalculates availability.
 * canManage (kitchen.manage_availability): take a dish off sale / back on
 * sale — a kill switch that never sets a quantity.
 */
export function KitchenAvailabilityBoard({ canManage, canWaste }: { canManage: boolean; canWaste: boolean }) {
  const supabase = usePortalSupabase();
  const [rows, setRows] = useState<Row[]>([]);
  const [items, setItems] = useState<Map<string, ItemInfo>>(new Map());
  const [variants, setVariants] = useState<Map<string, VariantInfo>>(new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [filter, setFilter] = useState('');

  const load = useCallback(async () => {
    const { data, error: e } = await supabase
      .from('product_availability')
      .select('menu_item_id, variant_id, status, producible_qty, reason, updated_at');
    if (e) {
      setError(e.message);
      setLoading(false);
      return;
    }
    const list = (data ?? []) as Row[];
    const itemIds = [...new Set(list.map((r) => r.menu_item_id))];
    const variantIds = [...new Set(list.map((r) => r.variant_id).filter((v): v is string => !!v))];
    const [it, va] = await Promise.all([
      itemIds.length
        ? supabase.from('menu_items').select('id, name, is_available').in('id', itemIds)
        : Promise.resolve({ data: [] }),
      variantIds.length
        ? supabase.from('menu_variants').select('id, name, is_available').in('id', variantIds)
        : Promise.resolve({ data: [] }),
    ]);
    setItems(new Map(((it.data ?? []) as ItemInfo[]).map((i) => [i.id, i])));
    setVariants(new Map(((va.data ?? []) as VariantInfo[]).map((v) => [v.id, v])));
    setRows(list);
    setError(null);
    setLoading(false);
  }, [supabase]);

  useEffect(() => {
    void load();
    const ch = supabase
      .channel('kitchen-availability')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'product_availability' }, () => void load())
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'menu_variants' }, () => void load())
      .subscribe();
    return () => {
      supabase.removeChannel(ch);
    };
  }, [supabase, load]);

  const name = useCallback(
    (r: Row) => {
      const item = items.get(r.menu_item_id)?.name ?? 'Item';
      const variant = r.variant_id ? variants.get(r.variant_id)?.name : null;
      return variant ? `${item} · ${variant}` : item;
    },
    [items, variants],
  );
  const onSale = useCallback(
    (r: Row) =>
      r.variant_id ? (variants.get(r.variant_id)?.is_available ?? true) : (items.get(r.menu_item_id)?.is_available ?? true),
    [items, variants],
  );

  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const order = { unavailable: 0, low_stock: 1, available: 2 } as const;
    return rows
      .filter((r) => !q || name(r).toLowerCase().includes(q))
      .sort((a, b) => order[a.status] - order[b.status] || name(a).localeCompare(name(b)));
  }, [rows, filter, name]);

  async function act(key: string, fn: () => PromiseLike<{ error: { message: string } | null }>, ok: string) {
    setBusy(key);
    setError(null);
    setNote(null);
    const { error: e } = await fn();
    setBusy(null);
    if (e) {
      setError(e.message);
      return;
    }
    setNote(ok);
    await load();
  }

  function waste(r: Row) {
    const v = window.prompt(`How many portions of ${name(r)} were wasted?`, '1');
    if (v == null) return;
    const n = parseInt(v, 10);
    if (Number.isNaN(n) || n <= 0) {
      setError('Enter a positive number of portions.');
      return;
    }
    const why = window.prompt('Reason (burnt, dropped, expired…):');
    if (!why?.trim()) return;
    void act(
      `${r.menu_item_id}:${r.variant_id}`,
      () =>
        supabase.rpc('record_dish_waste', {
          p_menu_item_id: r.menu_item_id,
          p_variant_id: r.variant_id,
          p_qty: n,
          p_reason: why.trim(),
        }),
      `Recorded ${n} × ${name(r)} as waste — ingredients deducted.`,
    );
  }

  function toggleSale(r: Row) {
    const next = !onSale(r);
    void act(
      `${r.menu_item_id}:${r.variant_id}`,
      () =>
        r.variant_id
          ? supabase.rpc('set_variant_available', { p_variant_id: r.variant_id, p_available: next, p_reason: 'kitchen' })
          : supabase.rpc('set_item_available', { p_menu_item_id: r.menu_item_id, p_available: next }),
      `${name(r)} ${next ? 'back on sale' : 'taken off sale'}.`,
    );
  }

  return (
    <Card className="p-0 overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-2 p-3 border-b border-border">
        <div>
          <h3 className="font-bold text-sm">Food availability</h3>
          <p className="text-muted text-[11px]">
            Portions the kitchen can make right now, from inventory and priority allocation. Updates live.
          </p>
        </div>
        <Input placeholder="Search" value={filter} onChange={(e) => setFilter(e.target.value)} className="w-44" />
      </div>
      {error && <div className="bg-danger/10 text-danger text-xs p-3">{error}</div>}
      {note && <div className="bg-ok/10 text-ok text-xs p-3">{note}</div>}
      {loading ? (
        <p className="p-3 text-muted text-xs">Loading…</p>
      ) : shown.length === 0 ? (
        <p className="p-3 text-muted text-xs">
          No dishes are tracked yet — a dish appears here once it has a recipe linked to inventory.
        </p>
      ) : (
        <div className="max-h-[28rem] overflow-y-auto">
          <table className="w-full text-left text-xs">
            <thead className="text-muted border-b border-border sticky top-0 bg-surface">
              <tr>
                <th className="p-2.5 font-semibold">Dish</th>
                <th className="p-2.5 font-semibold text-right">Available</th>
                <th className="p-2.5 font-semibold">Status</th>
                {(canManage || canWaste) && <th className="p-2.5" />}
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => {
                const key = `${r.menu_item_id}:${r.variant_id}`;
                const sale = onSale(r);
                return (
                  <tr key={key} className="border-b border-border/60 last:border-0 align-middle">
                    <td className="p-2.5">
                      <div className="font-semibold">{name(r)}</div>
                      {r.reason && <div className="text-muted text-[11px]">{r.reason}</div>}
                    </td>
                    <td className="p-2.5 text-right font-mono tabular-nums text-sm font-bold">
                      {r.producible_qty == null ? '—' : Math.floor(Number(r.producible_qty))}
                    </td>
                    <td className="p-2.5">
                      <span className={`font-semibold ${STATUS[r.status].tone}`}>{STATUS[r.status].label}</span>
                      {!sale && <div className="text-[10px] text-danger font-bold uppercase">off sale</div>}
                    </td>
                    {(canManage || canWaste) && (
                      <td className="p-2.5">
                        <div className="flex flex-wrap justify-end gap-1.5">
                          {canWaste && (
                            <Button variant="danger" disabled={busy === key} onClick={() => waste(r)}>
                              Waste
                            </Button>
                          )}
                          {canManage && (
                            <Button variant="ghost" disabled={busy === key} onClick={() => toggleSale(r)}>
                              {sale ? 'Take off sale' : 'Put on sale'}
                            </Button>
                          )}
                        </div>
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
