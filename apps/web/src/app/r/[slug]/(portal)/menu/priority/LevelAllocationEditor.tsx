'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { usePortalSupabase } from '@/components/PortalProvider';
import { Button, Input } from '@/components/ui';

export type LevelAllocation = {
  priority_level: 'critical' | 'high' | 'medium' | 'low';
  allocation_pct: number;
  is_active: boolean;
};

const LEVELS: { key: LevelAllocation['priority_level']; label: string }[] = [
  { key: 'critical', label: 'Critical' },
  { key: 'high', label: 'High' },
  { key: 'medium', label: 'Medium' },
  { key: 'low', label: 'Low' },
];

const DEFAULTS: Record<LevelAllocation['priority_level'], number> = { critical: 40, high: 30, medium: 20, low: 10 };

/**
 * How shared production capacity is divided between the four priority
 * levels. Saved through set_priority_level_allocation(), which re-validates
 * the total server-side and reallocates immediately; this form only gives
 * instant feedback while typing.
 */
export function LevelAllocationEditor({ initial, canManage }: { initial: LevelAllocation[]; canManage: boolean }) {
  const router = useRouter();
  const supabase = usePortalSupabase();
  const fromProps = useMemo(
    () =>
      LEVELS.map((l) => {
        const row = initial.find((r) => r.priority_level === l.key);
        return {
          priority_level: l.key,
          pct: String(row ? Number(row.allocation_pct) : DEFAULTS[l.key]),
          is_active: row ? row.is_active : true,
        };
      }),
    [initial],
  );
  const [rows, setRows] = useState(fromProps);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  useEffect(() => setRows(fromProps), [fromProps]);

  const invalid = rows.find((r) => !/^\d{1,3}(\.\d{1,2})?$/.test(r.pct.trim()) || Number(r.pct) > 100);
  const total = Math.round(rows.reduce((s, r) => s + (Number(r.pct) || 0), 0) * 100) / 100;
  const totalOk = !invalid && total === 100;
  const dirty = rows.some((r, i) => r.pct !== fromProps[i].pct || r.is_active !== fromProps[i].is_active);

  async function save() {
    if (!totalOk) return;
    setBusy(true);
    setError(null);
    setSaved(false);
    const { error: e } = await supabase.rpc('set_priority_level_allocation', {
      p_config: rows.map((r) => ({ priority_level: r.priority_level, allocation_pct: r.pct.trim(), is_active: r.is_active })),
    });
    setBusy(false);
    if (e) {
      setError(e.message.replace(/^bad_(total|percentage|config):\s*/, ''));
      return;
    }
    setSaved(true);
    router.refresh();
  }

  return (
    <div className="rounded-lg border border-border bg-surface p-4">
      <h2 className="font-bold text-sm">Share of limited stock by priority</h2>
      <p className="text-muted text-[11px] mt-1 max-w-2xl">
        When dishes share an ingredient that&rsquo;s running short, each level gets this share of what can actually be
        made. A share a level can&rsquo;t use — its dishes are stopped by another ingredient — is passed on to the
        other levels, so nothing sits unused. Stock is never reserved or moved.
      </p>

      <div className="mt-3 grid grid-cols-2 sm:grid-cols-4 gap-3 max-w-2xl">
        {rows.map((r, i) => {
          const label = LEVELS[i].label;
          const bad = !/^\d{1,3}(\.\d{1,2})?$/.test(r.pct.trim()) || Number(r.pct) > 100;
          return (
            <div key={r.priority_level} className={`rounded-md border p-2.5 ${r.is_active ? 'border-border' : 'border-border/50 opacity-60'}`}>
              <div className="flex items-center justify-between">
                <span className="text-xs font-bold">{label}</span>
                <label className="flex items-center gap-1 text-[10px] text-muted">
                  <input
                    type="checkbox"
                    checked={r.is_active}
                    disabled={!canManage}
                    onChange={(e) => setRows((rs) => rs.map((x, j) => (j === i ? { ...x, is_active: e.target.checked } : x)))}
                  />
                  Active
                </label>
              </div>
              <div className="mt-1.5 flex items-center gap-1">
                <Input
                  inputMode="decimal"
                  value={r.pct}
                  disabled={!canManage}
                  aria-label={`${label} percentage`}
                  onChange={(e) => {
                    setSaved(false);
                    setRows((rs) => rs.map((x, j) => (j === i ? { ...x, pct: e.target.value } : x)));
                  }}
                  className={`text-right tabular-nums ${bad ? 'border-danger' : ''}`}
                />
                <span className="text-xs text-muted">%</span>
              </div>
            </div>
          );
        })}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-3">
        <span className={`text-xs font-bold tabular-nums ${totalOk ? 'text-ok' : 'text-danger'}`}>
          Total: {Number.isFinite(total) ? total : '—'}%
        </span>
        {!totalOk && (
          <span className="text-[11px] text-danger">
            {invalid ? 'Each level needs a number from 0 to 100.' : `Must total exactly 100% (${total > 100 ? `${Math.round((total - 100) * 100) / 100} over` : `${Math.round((100 - total) * 100) / 100} short`}).`}
          </span>
        )}
        {canManage && (
          <Button disabled={busy || !totalOk || !dirty} onClick={save}>
            {busy ? 'Saving…' : 'Save shares'}
          </Button>
        )}
        {saved && !dirty && <span className="text-[11px] text-ok">Saved — availability recalculated.</span>}
      </div>
      {rows.some((r) => !r.is_active) && (
        <p className="text-[11px] text-muted mt-2">
          An inactive level&rsquo;s share goes to the active levels; its dishes only get what&rsquo;s left over.
        </p>
      )}
      {error && <p className="text-danger text-xs mt-2">{error}</p>}
    </div>
  );
}
