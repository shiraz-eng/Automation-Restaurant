'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { usePortalSupabase } from '@/components/PortalProvider';
import { Button, Card, Field, Input } from '@/components/ui';

type Item = {
  id: string;
  name: string;
  unit: string;
  stock_qty: number;
  min_threshold: number;
  supplier_name: string | null;
};

export function InventoryManager({ items }: { items: Item[] }) {
  const router = useRouter();
  const supabase = usePortalSupabase();
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [deltas, setDeltas] = useState<Record<string, string>>({});

  const [newName, setNewName] = useState('');
  const [newUnit, setNewUnit] = useState('unit');
  const [newMin, setNewMin] = useState('0');
  const [adding, setAdding] = useState(false);

  async function adjust(item: Item, sign: 1 | -1) {
    const raw = parseFloat(deltas[item.id] ?? '');
    if (Number.isNaN(raw) || raw <= 0) {
      setError('Enter a positive amount to add or remove.');
      return;
    }
    setBusyId(item.id);
    setError(null);
    const { error } = await supabase.rpc('adjust_stock', {
      p_inventory_item_id: item.id,
      p_delta: sign * raw,
      p_reason: sign > 0 ? 'restock' : 'adjustment',
      p_note: null,
    });
    setBusyId(null);
    if (error) {
      setError(error.message);
      return;
    }
    setDeltas((d) => ({ ...d, [item.id]: '' }));
    router.refresh();
  }

  async function addItem(e: React.FormEvent) {
    e.preventDefault();
    if (!newName.trim()) {
      setError('Name is required.');
      return;
    }
    setAdding(true);
    setError(null);
    const { error } = await supabase.from('inventory_items').insert({
      name: newName.trim(),
      unit: newUnit.trim() || 'unit',
      min_threshold: Number(newMin) || 0,
      stock_qty: 0,
    });
    setAdding(false);
    if (error) {
      setError(error.message);
      return;
    }
    setNewName('');
    setNewUnit('unit');
    setNewMin('0');
    router.refresh();
  }

  return (
    <div className="space-y-6">
      {error && (
        <div className="rounded border border-danger/40 bg-danger/10 text-danger p-3 text-xs">
          {error}
        </div>
      )}

      <Card>
        <h2 className="font-bold mb-3 text-sm">Add item</h2>
        <form onSubmit={addItem} className="grid grid-cols-1 sm:grid-cols-4 gap-3 items-end">
          <Field label="Name">
            <Input value={newName} onChange={(e) => setNewName(e.target.value)} />
          </Field>
          <Field label="Unit">
            <Input value={newUnit} onChange={(e) => setNewUnit(e.target.value)} />
          </Field>
          <Field label="Min threshold">
            <Input
              type="number"
              min="0"
              step="0.001"
              value={newMin}
              onChange={(e) => setNewMin(e.target.value)}
            />
          </Field>
          <Button type="submit" disabled={adding}>
            Add
          </Button>
        </form>
      </Card>

      <Card className="p-0 overflow-hidden">
        <table className="w-full text-left text-xs">
          <thead className="text-muted border-b border-border">
            <tr>
              <th className="p-3 font-semibold">Item</th>
              <th className="p-3 font-semibold text-right">On hand</th>
              <th className="p-3 font-semibold text-right">Min</th>
              <th className="p-3 font-semibold">Adjust</th>
            </tr>
          </thead>
          <tbody>
            {items.length === 0 ? (
              <tr>
                <td colSpan={4} className="p-3 text-muted">
                  No items yet.
                </td>
              </tr>
            ) : (
              items.map((it) => {
                const low = Number(it.stock_qty) <= Number(it.min_threshold);
                return (
                  <tr key={it.id} className="border-b border-border/60">
                    <td className="p-3 font-semibold">
                      {it.name}
                      {low && <span className="ml-2 text-danger">low</span>}
                    </td>
                    <td className="p-3 text-right font-mono">
                      {it.stock_qty} {it.unit}
                    </td>
                    <td className="p-3 text-right text-muted">{it.min_threshold}</td>
                    <td className="p-3">
                      <div className="flex items-center gap-1.5">
                        <Input
                          type="number"
                          min="0"
                          step="0.001"
                          placeholder="qty"
                          className="w-20"
                          value={deltas[it.id] ?? ''}
                          onChange={(e) =>
                            setDeltas((d) => ({ ...d, [it.id]: e.target.value }))
                          }
                        />
                        <Button
                          variant="ghost"
                          disabled={busyId === it.id}
                          onClick={() => adjust(it, 1)}
                        >
                          + add
                        </Button>
                        <Button
                          variant="danger"
                          disabled={busyId === it.id}
                          onClick={() => adjust(it, -1)}
                        >
                          − use
                        </Button>
                      </div>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </Card>
    </div>
  );
}
