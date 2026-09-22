'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { usePortalSupabase } from '@/components/PortalProvider';
import { Button, Card, Field, Input, Select } from '@/components/ui';
import { formatCents } from '@/lib/format';

type Item = {
  id: string;
  name: string;
  unit: string;
  stock_qty: number;
  min_threshold: number;
  target_stock_qty: number | null;
  auto_reorder_email: boolean;
  supplier_name: string | null;
  cost_cents_per_base_unit: number;
};
type Supplier = { id: string; name: string; email: string | null };

/** adjust_stock / record_ingredient_waste / submit_stock_count reject over
 *  the wire with terse Postgres error codes (e.g. "insufficient_stock: <uuid>")
 *  rather than a message meant for an end user — translate the ones staff can
 *  actually trigger into plain language naming the item they were editing. */
function friendlyStockError(message: string, item: Item): string {
  if (message.startsWith('insufficient_stock')) {
    return `Only ${item.stock_qty} ${item.unit} of ${item.name} in stock — enter an amount at or below that.`;
  }
  if (message.startsWith('would_go_negative')) {
    return `That would take ${item.name} below zero stock.`;
  }
  if (message.startsWith('reason_required')) {
    return 'A reason is required to record waste.';
  }
  if (message.startsWith('bad_qty')) {
    return 'Enter a quantity greater than zero.';
  }
  if (message.startsWith('forbidden')) {
    return "You don't have permission to do that.";
  }
  return message;
}

export function InventoryManager({
  items,
  canViewCost,
  canManageAutomation,
  suppliers,
  preferredBySupplierItem,
  lowStockEmailEnabled,
}: {
  items: Item[];
  canViewCost: boolean;
  canManageAutomation: boolean;
  suppliers: Supplier[];
  preferredBySupplierItem: Record<string, { supplierItemId: string; supplierId: string }>;
  lowStockEmailEnabled: boolean;
}) {
  const router = useRouter();
  const supabase = usePortalSupabase();
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [deltas, setDeltas] = useState<Record<string, string>>({});
  const [automationBusy, setAutomationBusy] = useState(false);

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
      setError(friendlyStockError(error.message, item));
      return;
    }
    setDeltas((d) => ({ ...d, [item.id]: '' }));
    router.refresh();
  }

  async function waste(item: Item) {
    const raw = parseFloat(deltas[item.id] ?? '');
    if (Number.isNaN(raw) || raw <= 0) {
      setError('Enter a positive amount wasted.');
      return;
    }
    const reason = window.prompt(`Reason for wasting ${raw} ${item.unit} of ${item.name}:`);
    if (!reason) return;
    setBusyId(item.id);
    setError(null);
    const { error } = await supabase.rpc('record_ingredient_waste', {
      p_inventory_item_id: item.id,
      p_qty: raw,
      p_note: reason,
    });
    setBusyId(null);
    if (error) {
      setError(friendlyStockError(error.message, item));
      return;
    }
    setDeltas((d) => ({ ...d, [item.id]: '' }));
    router.refresh();
  }

  async function count(item: Item) {
    const v = window.prompt(`Physical count for ${item.name} (currently ${item.stock_qty} ${item.unit}):`, String(item.stock_qty));
    if (v == null) return;
    const counted = parseFloat(v);
    if (Number.isNaN(counted) || counted < 0) {
      setError('Enter a valid non-negative count.');
      return;
    }
    setBusyId(item.id);
    setError(null);
    const { error } = await supabase.rpc('submit_stock_count', {
      p_inventory_item_id: item.id,
      p_counted_qty: counted,
      p_note: null,
    });
    setBusyId(null);
    if (error) {
      setError(friendlyStockError(error.message, item));
      return;
    }
    router.refresh();
  }

  async function setCost(item: Item) {
    const v = window.prompt(
      `Cost per ${item.unit} for ${item.name} (used for recipe/food-cost calculations):`,
      (item.cost_cents_per_base_unit / 100).toFixed(4),
    );
    if (v == null) return;
    const cents = Math.round(parseFloat(v) * 100);
    if (Number.isNaN(cents) || cents < 0) {
      setError('Enter a valid cost.');
      return;
    }
    setBusyId(item.id);
    setError(null);
    const { error } = await supabase
      .from('inventory_items')
      .update({ cost_cents_per_base_unit: cents })
      .eq('id', item.id);
    setBusyId(null);
    if (error) {
      setError(error.message);
      return;
    }
    router.refresh();
  }

  async function setTarget(item: Item) {
    const v = window.prompt(
      `Target stock for ${item.name} (${item.unit}) — used to size the automatic low-stock reorder email. Leave blank to clear.`,
      item.target_stock_qty != null ? String(item.target_stock_qty) : '',
    );
    if (v == null) return;
    const trimmed = v.trim();
    const target = trimmed === '' ? null : parseFloat(trimmed);
    if (trimmed !== '' && (Number.isNaN(target) || (target as number) < 0)) {
      setError('Enter a valid non-negative target, or leave blank to clear it.');
      return;
    }
    setBusyId(item.id);
    setError(null);
    const { error } = await supabase.from('inventory_items').update({ target_stock_qty: target }).eq('id', item.id);
    setBusyId(null);
    if (error) {
      setError(error.message);
      return;
    }
    router.refresh();
  }

  async function setPreferredSupplier(item: Item, supplierId: string) {
    setBusyId(item.id);
    setError(null);
    const existing = preferredBySupplierItem[item.id];
    if (existing && existing.supplierId === supplierId) {
      setBusyId(null);
      return;
    }
    // Only one preferred supplier per item — clear any other preferred row
    // for this item before setting the new one (or clearing to "none").
    if (existing) {
      await supabase.from('supplier_items').update({ is_preferred: false }).eq('id', existing.supplierItemId);
    }
    if (supplierId) {
      const { data: already } = await supabase
        .from('supplier_items')
        .select('id')
        .eq('supplier_id', supplierId)
        .eq('inventory_item_id', item.id)
        .maybeSingle();
      const { error } = already
        ? await supabase.from('supplier_items').update({ is_preferred: true }).eq('id', already.id)
        : await supabase.from('supplier_items').insert({ supplier_id: supplierId, inventory_item_id: item.id, is_preferred: true });
      setBusyId(null);
      if (error) {
        setError(error.message);
        return;
      }
    } else {
      setBusyId(null);
    }
    router.refresh();
  }

  async function toggleItemAutomation(item: Item) {
    setBusyId(item.id);
    setError(null);
    const { error } = await supabase.from('inventory_items').update({ auto_reorder_email: !item.auto_reorder_email }).eq('id', item.id);
    setBusyId(null);
    if (error) {
      setError(error.message);
      return;
    }
    router.refresh();
  }

  async function toggleLowStockEmailEnabled() {
    setAutomationBusy(true);
    setError(null);
    const { error } = await supabase.from('purchasing_settings').update({ low_stock_email_enabled: !lowStockEmailEnabled }).eq('id', true);
    setAutomationBusy(false);
    if (error) {
      setError(error.message);
      return;
    }
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

      {canManageAutomation && (
        <Card className="flex items-center justify-between gap-3">
          <div>
            <h2 className="font-bold text-sm">AI Management — low-stock supplier email</h2>
            <p className="text-[11px] text-muted mt-0.5">
              When an ingredient falls to or below its minimum and has a target stock + preferred supplier set below,
              automatically email that supplier a reorder request. Never sends twice for the same low-stock spell,
              and stops once stock recovers.
            </p>
          </div>
          <Button
            variant={lowStockEmailEnabled ? 'danger' : 'primary'}
            disabled={automationBusy}
            onClick={toggleLowStockEmailEnabled}
            className="shrink-0"
          >
            {lowStockEmailEnabled ? 'Turn off' : 'Turn on'}
          </Button>
        </Card>
      )}

      <Card>
        <h2 className="font-bold mb-3 text-sm">Add ingredient</h2>
        <p className="text-[11px] text-muted mb-3">
          Enter this ingredient&apos;s <b>base unit</b> — the smallest amount recipes measure in (e.g. &ldquo;g&rdquo;
          for grams, &ldquo;ml&rdquo;, or &ldquo;piece&rdquo;). Stock and recipe quantities are always in this unit.
        </p>
        <form onSubmit={addItem} className="grid grid-cols-1 sm:grid-cols-4 gap-3 items-end">
          <Field label="Name">
            <Input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="Chicken Breast" />
          </Field>
          <Field label="Base unit">
            <Input value={newUnit} onChange={(e) => setNewUnit(e.target.value)} placeholder="g" />
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
        <div className="overflow-x-auto">
        <table className="w-full text-left text-xs">
          <thead className="text-muted border-b border-border">
            <tr>
              <th className="p-3 font-semibold">Ingredient</th>
              <th className="p-3 font-semibold text-right">On hand</th>
              <th className="p-3 font-semibold text-right">Min</th>
              {canManageAutomation && <th className="p-3 font-semibold text-right">Target</th>}
              {canManageAutomation && <th className="p-3 font-semibold">Preferred supplier</th>}
              {canViewCost && <th className="p-3 font-semibold text-right">Cost</th>}
              {canViewCost && <th className="p-3 font-semibold text-right">Value</th>}
              <th className="p-3 font-semibold">Record</th>
            </tr>
          </thead>
          <tbody>
            {items.length === 0 ? (
              <tr>
                <td colSpan={4 + (canManageAutomation ? 2 : 0) + (canViewCost ? 2 : 0)} className="p-3 text-muted">
                  No ingredients yet.
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
                    {canManageAutomation && (
                      <td className="p-3 text-right">
                        <button onClick={() => setTarget(it)} className="font-mono text-primary underline decoration-dotted">
                          {it.target_stock_qty != null ? it.target_stock_qty : 'set'}
                        </button>
                      </td>
                    )}
                    {canManageAutomation && (
                      <td className="p-3">
                        <div className="flex items-center gap-2">
                          <Select
                            value={preferredBySupplierItem[it.id]?.supplierId ?? ''}
                            onChange={(e) => setPreferredSupplier(it, e.target.value as string)}
                            disabled={busyId === it.id}
                            className="text-[11px]"
                          >
                            <option value="">— none —</option>
                            {suppliers.map((s) => (
                              <option key={s.id} value={s.id} disabled={!s.email}>
                                {s.name}
                                {!s.email ? ' (no email)' : ''}
                              </option>
                            ))}
                          </Select>
                          <label className="flex items-center gap-1 text-[10px] text-muted whitespace-nowrap" title="Include this ingredient in the automatic low-stock reorder email">
                            <input
                              type="checkbox"
                              checked={it.auto_reorder_email}
                              onChange={() => toggleItemAutomation(it)}
                              disabled={busyId === it.id}
                            />
                            auto-email
                          </label>
                        </div>
                      </td>
                    )}
                    {canViewCost && (
                      <td className="p-3 text-right">
                        <button onClick={() => setCost(it)} className="font-mono text-primary underline decoration-dotted">
                          {formatCents(Math.round(it.cost_cents_per_base_unit))}/{it.unit}
                        </button>
                      </td>
                    )}
                    {canViewCost && (
                      <td className="p-3 text-right font-mono text-muted">
                        {formatCents(Math.round(Number(it.stock_qty) * Number(it.cost_cents_per_base_unit)))}
                      </td>
                    )}
                    <td className="p-3">
                      <div className="flex items-center gap-1.5 flex-wrap">
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
                          + restock
                        </Button>
                        <Button
                          variant="danger"
                          disabled={busyId === it.id}
                          onClick={() => waste(it)}
                        >
                          − waste
                        </Button>
                        <Button
                          variant="ghost"
                          disabled={busyId === it.id}
                          onClick={() => count(it)}
                        >
                          Stock count
                        </Button>
                      </div>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
        </div>
      </Card>
    </div>
  );
}
