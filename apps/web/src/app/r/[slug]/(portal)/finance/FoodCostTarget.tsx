'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { usePortalSupabase } from '@/components/PortalProvider';

/** The restaurant's food-cost target (set_food_cost_target()). */
export function FoodCostTarget({ targetPct, canEdit }: { targetPct: number; canEdit: boolean }) {
  const supabase = usePortalSupabase();
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(String(targetPct));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (!canEdit) return <span className="text-xs text-muted">Target {targetPct}%</span>;
  if (!editing) {
    return (
      <button type="button" onClick={() => setEditing(true)} className="text-xs text-primary underline">
        Target {targetPct}% · change
      </button>
    );
  }
  async function save() {
    setBusy(true);
    setError(null);
    const { error: e } = await supabase.rpc('set_food_cost_target', { p_pct: Number(value) });
    setBusy(false);
    if (e) setError(e.message);
    else {
      setEditing(false);
      router.refresh();
    }
  }
  return (
    <span className="flex items-center gap-1.5 text-xs">
      Target
      <input
        type="number"
        min="1"
        max="90"
        step="0.5"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        className="w-16 rounded border border-border bg-surface px-1.5 py-0.5"
      />
      %
      <button type="button" disabled={busy} onClick={() => void save()} className="rounded bg-primary px-2 py-0.5 font-semibold text-primary-fg">
        Save
      </button>
      <button type="button" onClick={() => setEditing(false)} className="text-muted">
        Cancel
      </button>
      {error && <span className="text-danger">{error}</span>}
    </span>
  );
}
