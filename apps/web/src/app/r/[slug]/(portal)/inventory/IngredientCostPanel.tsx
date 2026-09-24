'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { usePortalSupabase } from '@/components/PortalProvider';
import { Button, Card, Input } from '@/components/ui';

type CostRow = { id: string; name: string; unit: string; cost_cents_per_base_unit: number | null };

/**
 * finance.manage_costs — set what each ingredient costs per base unit.
 * Writes go through set_ingredient_cost(), which checks the key and logs the
 * old/new cost; recipe food cost and COGS pick the new value up from there.
 */
export function IngredientCostPanel() {
  const supabase = usePortalSupabase();
  const [rows, setRows] = useState<CostRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [draft, setDraft] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    const { data, error: e } = await supabase
      .from('inventory_items')
      .select('id, name, unit, cost_cents_per_base_unit')
      .order('name');
    if (e) setError(e.message);
    else setRows((data ?? []) as CostRow[]);
    setLoading(false);
  }, [supabase]);

  useEffect(() => {
    void load();
  }, [load]);

  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return rows.filter((r) => !q || r.name.toLowerCase().includes(q));
  }, [rows, filter]);

  async function save(r: CostRow) {
    const v = parseFloat(draft[r.id] ?? '');
    if (!Number.isFinite(v) || v < 0) {
      setError('Enter a cost of 0 or more.');
      return;
    }
    setBusyId(r.id);
    setError(null);
    setNote(null);
    // Entered per unit in currency; stored as cents per base unit.
    const { error: e } = await supabase.rpc('set_ingredient_cost', {
      p_item_id: r.id,
      p_cost_cents_per_base_unit: Math.round(v * 100 * 10000) / 10000,
    });
    setBusyId(null);
    if (e) {
      setError(e.message);
      return;
    }
    setNote(`${r.name} cost updated.`);
    setDraft((d) => ({ ...d, [r.id]: '' }));
    await load();
  }

  return (
    <Card className="p-0 overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-2 p-3 border-b border-border">
        <div>
          <h3 className="font-bold text-sm">Ingredient costs</h3>
          <p className="text-muted text-[11px]">Cost per base unit. Recipe food cost and COGS use these figures.</p>
        </div>
        <Input placeholder="Search" value={filter} onChange={(e) => setFilter(e.target.value)} className="w-48" />
      </div>
      {error && <div className="bg-danger/10 text-danger text-xs p-3">{error}</div>}
      {note && <div className="bg-ok/10 text-ok text-xs p-3">{note}</div>}
      {loading ? (
        <p className="p-3 text-muted text-xs">Loading…</p>
      ) : shown.length === 0 ? (
        <p className="p-3 text-muted text-xs">No ingredients.</p>
      ) : (
        <div className="max-h-[28rem] overflow-y-auto">
          <table className="w-full text-left text-xs">
            <thead className="text-muted border-b border-border sticky top-0 bg-surface">
              <tr>
                <th className="p-2.5 font-semibold">Ingredient</th>
                <th className="p-2.5 font-semibold text-right">Current cost / unit</th>
                <th className="p-2.5 font-semibold">New cost / unit</th>
                <th className="p-2.5" />
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => (
                <tr key={r.id} className="border-b border-border/60 last:border-0">
                  <td className="p-2.5 font-semibold">{r.name}</td>
                  <td className="p-2.5 text-right font-mono tabular-nums">
                    {r.cost_cents_per_base_unit == null
                      ? '—'
                      : `${(Number(r.cost_cents_per_base_unit) / 100).toFixed(4)} / ${r.unit}`}
                  </td>
                  <td className="p-2.5">
                    <Input
                      type="number"
                      step="0.0001"
                      min="0"
                      value={draft[r.id] ?? ''}
                      onChange={(e) => setDraft((d) => ({ ...d, [r.id]: e.target.value }))}
                      className="w-28"
                    />
                  </td>
                  <td className="p-2.5 text-right">
                    <Button disabled={busyId === r.id || !(draft[r.id] ?? '').trim()} onClick={() => save(r)}>
                      Save
                    </Button>
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
