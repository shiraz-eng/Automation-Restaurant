'use client';

import { useEffect, useState } from 'react';
import { usePortalSupabase } from '@/components/PortalProvider';
import { formatCents } from '@/lib/format';

/**
 * Net Profit drill-down (spec §8-10, §28, §51): the owner clicks Net
 * Profit and walks DOWN through the exact same numbers already shown —
 * Gross Profit / Expenses, then Net Sales / COGS, then a per-item COGS
 * breakdown, then a single item's actual recipe ingredients — never a
 * second, re-derived calculation. Each level lazy-fetches only what it
 * needs (no upfront "download everything"), using the same RPCs/tables
 * the rest of the app already reads.
 *
 * Takes a plain `from`/`to` Date range rather than a named Period so it
 * can be shared by both the Dashboard (a named period like "this_month")
 * and the /finance page (a fixed rolling 30-day window) without either
 * caller reshaping its own period concept to fit this component.
 */

type ProfitRow = {
  gross_sales_cents: number;
  discount_cents: number;
  refunded_cents: number;
  net_sales_cents: number;
  theoretical_cogs_cents: number;
  gross_profit_cents: number;
  gross_margin_pct: number | null;
  expenses_cents: number;
  net_profit_cents: number;
  net_profit_margin_pct: number | null;
};

type Level =
  | { kind: 'net_profit' }
  | { kind: 'expenses' }
  | { kind: 'gross_profit' }
  | { kind: 'net_sales' }
  | { kind: 'cogs' }
  | { kind: 'item'; menuItemId: string; variantId: string; name: string };

const LEVEL_LABEL: Record<Level['kind'], string> = {
  net_profit: 'Net Profit',
  expenses: 'Expenses',
  gross_profit: 'Gross Profit',
  net_sales: 'Net Sales',
  cogs: 'COGS',
  item: 'Item',
};

function Row({ label, value, bold, indent }: { label: string; value: string; bold?: boolean; indent?: boolean }) {
  return (
    <div className={`flex items-center justify-between py-1 ${indent ? 'pl-3 text-muted' : ''}`}>
      <span className={bold ? 'font-bold' : ''}>{label}</span>
      <span className={`font-mono ${bold ? 'font-bold' : ''}`}>{value}</span>
    </div>
  );
}

function DrillButton({ label, value, onClick }: { label: string; value: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="w-full flex items-center justify-between py-2 px-2.5 -mx-2.5 rounded hover:bg-primary/10 text-left group"
    >
      <span className="flex items-center gap-1.5">
        {label}
        <span className="text-muted text-[10px] opacity-0 group-hover:opacity-100">drill in →</span>
      </span>
      <span className="font-mono">{value}</span>
    </button>
  );
}

export function ProfitDrilldownModal({
  profit,
  from,
  to,
  periodLabel,
  onClose,
  initialLevel = 'net_profit',
}: {
  profit: ProfitRow;
  from: Date;
  to: Date;
  periodLabel: string;
  onClose: () => void;
  initialLevel?: 'net_profit' | 'gross_profit';
}) {
  const [stack, setStack] = useState<Level[]>([{ kind: initialLevel }]);
  const current = stack[stack.length - 1]!;

  function push(level: Level) {
    setStack((s) => [...s, level]);
  }
  function back() {
    setStack((s) => (s.length > 1 ? s.slice(0, -1) : s));
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div
        className="max-w-lg w-full max-h-[85vh] overflow-y-auto rounded-lg border border-border bg-surface p-5 space-y-3"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-xs text-muted">
            {stack.length > 1 && (
              <button onClick={back} className="font-bold text-primary">
                ← Back
              </button>
            )}
            <span>{periodLabel}</span>
          </div>
          <button onClick={onClose} className="text-muted text-xs">
            ✕
          </button>
        </div>
        <h3 className="font-black text-sm -mt-1">{LEVEL_LABEL[current.kind]}{current.kind === 'item' ? `: ${current.name}` : ''}</h3>

        {current.kind === 'net_profit' && (
          <div className="text-xs border border-border rounded-lg p-3">
            <DrillButton label="Gross Profit" value={formatCents(profit.gross_profit_cents)} onClick={() => push({ kind: 'gross_profit' })} />
            <Row label="− Labor" value="not tracked separately" indent />
            <DrillButton label="− Operating Expenses" value={`-${formatCents(profit.expenses_cents)}`} onClick={() => push({ kind: 'expenses' })} />
            <div className="border-t border-border mt-1 pt-1">
              <Row label="= Net Profit" value={formatCents(profit.net_profit_cents)} bold />
            </div>
            <p className="text-muted text-[11px] mt-2">
              Labor/payroll isn&apos;t tracked as its own cost — it&apos;s only reflected in Net Profit if it was
              entered as an expense record. Click a line above to see what it&apos;s made of.
            </p>
          </div>
        )}

        {current.kind === 'gross_profit' && (
          <div className="text-xs border border-border rounded-lg p-3">
            <DrillButton label="Net Sales" value={formatCents(profit.net_sales_cents)} onClick={() => push({ kind: 'net_sales' })} />
            <DrillButton label="− COGS (theoretical)" value={`-${formatCents(profit.theoretical_cogs_cents)}`} onClick={() => push({ kind: 'cogs' })} />
            <div className="border-t border-border mt-1 pt-1">
              <Row label="= Gross Profit" value={formatCents(profit.gross_profit_cents)} bold />
              <Row label="Gross margin" value={profit.gross_margin_pct != null ? `${profit.gross_margin_pct}%` : 'N/A'} indent />
            </div>
          </div>
        )}

        {current.kind === 'net_sales' && (
          <div className="text-xs border border-border rounded-lg p-3 space-y-0.5">
            <Row label="Gross Sales" value={formatCents(profit.gross_sales_cents)} />
            <Row label="− Discounts" value={`-${formatCents(profit.discount_cents)}`} indent />
            <Row label="− Refunds" value={`-${formatCents(profit.refunded_cents)}`} indent />
            <div className="border-t border-border mt-1 pt-1">
              <Row label="= Net Sales" value={formatCents(profit.net_sales_cents)} bold />
            </div>
            <p className="text-muted text-[11px] mt-2">
              Discounts and refunds come from each order&apos;s own recorded values, not reconstructed from
              today&apos;s menu.
            </p>
          </div>
        )}

        {current.kind === 'expenses' && <ExpensesLevel from={from} to={to} totalCents={profit.expenses_cents} />}
        {current.kind === 'cogs' && (
          <CogsLevel from={from} to={to} totalCents={profit.theoretical_cogs_cents} onSelectItem={(l) => push(l)} />
        )}
        {current.kind === 'item' && <ItemLevel menuItemId={current.menuItemId} variantId={current.variantId} />}
      </div>
    </div>
  );
}

function ExpensesLevel({ from, to, totalCents }: { from: Date; to: Date; totalCents: number }) {
  const supabase = usePortalSupabase();
  const [rows, setRows] = useState<{ category: string; description: string | null; amount_cents: number; expense_date: string }[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    supabase
      .from('expenses')
      .select('category, description, amount_cents, expense_date')
      .gte('expense_date', from.toISOString().slice(0, 10))
      .lte('expense_date', to.toISOString().slice(0, 10))
      .order('amount_cents', { ascending: false })
      .then(({ data, error: err }) => {
        if (cancelled) return;
        if (err) setError(err.message);
        else setRows(data ?? []);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [from.getTime(), to.getTime(), supabase]);

  if (error) return <p className="text-danger text-xs">{error}</p>;
  if (!rows) return <p className="text-muted text-xs">Loading expense records…</p>;
  if (rows.length === 0) {
    return <p className="text-muted text-xs">No expense records dated in this period. Net Profit above reflects $0 in expenses.</p>;
  }

  const byCategory = rows.reduce<Record<string, number>>((acc, r) => {
    acc[r.category] = (acc[r.category] ?? 0) + r.amount_cents;
    return acc;
  }, {});

  return (
    <div className="text-xs space-y-3">
      <div className="border border-border rounded-lg p-3 space-y-0.5">
        {Object.entries(byCategory)
          .sort((a, b) => b[1] - a[1])
          .map(([cat, cents]) => (
            <Row key={cat} label={cat} value={formatCents(cents)} />
          ))}
        <div className="border-t border-border mt-1 pt-1">
          <Row label="Total expenses" value={formatCents(totalCents)} bold />
        </div>
      </div>
      <div>
        <p className="font-bold mb-1">Individual records ({rows.length})</p>
        <div className="max-h-56 overflow-y-auto border border-border rounded-lg divide-y divide-border">
          {rows.map((r, i) => (
            <div key={i} className="flex items-center justify-between p-2">
              <div className="min-w-0">
                <div className="font-semibold">{r.category}</div>
                <div className="text-muted text-[11px] truncate">{r.description || '—'} · {r.expense_date}</div>
              </div>
              <div className="font-mono shrink-0 ml-2">{formatCents(r.amount_cents)}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function CogsLevel({
  from,
  to,
  totalCents,
  onSelectItem,
}: {
  from: Date;
  to: Date;
  totalCents: number;
  onSelectItem: (level: { kind: 'item'; menuItemId: string; variantId: string; name: string }) => void;
}) {
  const supabase = usePortalSupabase();
  const [rows, setRows] = useState<
    { menu_item_id: string; variant_id: string; name: string; qty_sold: number; cogs_cents: number; cogs_known: boolean; revenue_cents: number; food_cost_pct: number | null }[] | null
  >(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    supabase
      .rpc('item_profitability', { p_from: from.toISOString(), p_to: to.toISOString() })
      .then(({ data, error: err }) => {
        if (cancelled) return;
        if (err) setError(err.message);
        else setRows((data as typeof rows) ?? []);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [from.getTime(), to.getTime(), supabase]);

  if (error) return <p className="text-danger text-xs">{error}</p>;
  if (!rows) return <p className="text-muted text-xs">Loading item cost breakdown…</p>;

  const sorted = rows.slice().sort((a, b) => b.cogs_cents - a.cogs_cents);
  const missing = sorted.filter((r) => !r.cogs_known).length;

  return (
    <div className="text-xs space-y-2">
      <Row label="Total COGS (theoretical)" value={formatCents(totalCents)} bold />
      {missing > 0 && (
        <p className="text-warn text-[11px]">{missing} item(s) below have no recipe configured — their cost shows as $0.00, understating the true total.</p>
      )}
      {sorted.length === 0 ? (
        <p className="text-muted">No à la carte sales in this period.</p>
      ) : (
        <div className="max-h-64 overflow-y-auto border border-border rounded-lg divide-y divide-border">
          {sorted.map((r) => (
            <button
              key={`${r.menu_item_id}-${r.variant_id}`}
              onClick={() => onSelectItem({ kind: 'item', menuItemId: r.menu_item_id, variantId: r.variant_id, name: r.name })}
              className="w-full flex items-center justify-between p-2 hover:bg-primary/10 text-left"
            >
              <div className="min-w-0">
                <div className="font-semibold flex items-center gap-1.5">
                  {r.name}
                  {!r.cogs_known && <span className="text-warn text-[10px]">no recipe</span>}
                </div>
                <div className="text-muted text-[11px]">{r.qty_sold} sold · {formatCents(r.revenue_cents)} revenue{r.food_cost_pct != null ? ` · ${r.food_cost_pct}% food cost` : ''}</div>
              </div>
              <div className="font-mono shrink-0 ml-2 font-bold">{formatCents(r.cogs_cents)}</div>
            </button>
          ))}
        </div>
      )}
      <p className="text-muted text-[11px]">Click an item to see its recipe&apos;s ingredient cost.</p>
    </div>
  );
}

function ItemLevel({ menuItemId, variantId }: { menuItemId: string; variantId: string }) {
  const supabase = usePortalSupabase();
  const [state, setState] = useState<
    | { status: 'loading' }
    | { status: 'no_recipe' }
    | { status: 'error'; message: string }
    | {
        status: 'ok';
        recipeName: string;
        yieldQty: number;
        yieldUnit: string | null;
        ingredients: { name: string; qty_base: number; unit: string; unit_cost_cents: number; line_cost_cents: number }[];
      }
  >({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data: recipes, error: rErr } = await supabase
        .from('recipes')
        .select('id, name, variant_id, current_version_id')
        .eq('menu_item_id', menuItemId)
        .eq('status', 'active');
      if (cancelled) return;
      if (rErr) return setState({ status: 'error', message: rErr.message });
      const match = (recipes ?? []).find((r) => r.variant_id === variantId) ?? (recipes ?? []).find((r) => r.variant_id === null);
      if (!match || !match.current_version_id) return setState({ status: 'no_recipe' });

      const { data: version, error: vErr } = await supabase
        .from('recipe_versions')
        .select('yield_qty, yield_unit, recipe_ingredients(qty_base, inventory_items(name, unit, cost_cents_per_base_unit))')
        .eq('id', match.current_version_id)
        .maybeSingle();
      if (cancelled) return;
      if (vErr || !version) return setState({ status: 'error', message: vErr?.message ?? 'Recipe version not found.' });

      type IngRow = { qty_base: number; inventory_items: { name: string; unit: string; cost_cents_per_base_unit: number } | { name: string; unit: string; cost_cents_per_base_unit: number }[] | null };
      const ingredients = ((version.recipe_ingredients ?? []) as IngRow[])
        .map((ing) => {
          const inv = Array.isArray(ing.inventory_items) ? ing.inventory_items[0] : ing.inventory_items;
          if (!inv) return null;
          return {
            name: inv.name,
            qty_base: ing.qty_base,
            unit: inv.unit,
            unit_cost_cents: inv.cost_cents_per_base_unit,
            line_cost_cents: Math.round(ing.qty_base * inv.cost_cents_per_base_unit),
          };
        })
        .filter((x): x is NonNullable<typeof x> => x !== null);

      setState({ status: 'ok', recipeName: match.name, yieldQty: version.yield_qty, yieldUnit: version.yield_unit, ingredients });
    })();
    return () => {
      cancelled = true;
    };
  }, [menuItemId, variantId, supabase]);

  if (state.status === 'loading') return <p className="text-muted text-xs">Loading recipe…</p>;
  if (state.status === 'error') return <p className="text-danger text-xs">{state.message}</p>;
  if (state.status === 'no_recipe') {
    return <p className="text-muted text-xs">No active recipe is configured for this item — its cost currently shows as $0.00 rather than a guessed value.</p>;
  }

  const total = state.ingredients.reduce((s, i) => s + i.line_cost_cents, 0);
  return (
    <div className="text-xs space-y-2">
      <p className="text-muted">
        Recipe: <span className="font-semibold text-body">{state.recipeName}</span>
        {state.yieldUnit ? ` — makes ${state.yieldQty} ${state.yieldUnit}` : ''}
      </p>
      <div className="border border-border rounded-lg divide-y divide-border">
        {state.ingredients.map((ing, i) => (
          <div key={i} className="flex items-center justify-between p-2">
            <div>
              <div className="font-semibold">{ing.name}</div>
              <div className="text-muted text-[11px]">
                {ing.qty_base}{ing.unit} @ {formatCents(ing.unit_cost_cents)}/{ing.unit}
              </div>
            </div>
            <div className="font-mono font-bold">{formatCents(ing.line_cost_cents)}</div>
          </div>
        ))}
      </div>
      <Row label="Recipe cost per unit" value={formatCents(total)} bold />
      <p className="text-muted text-[11px]">
        This is the CURRENT recipe and ingredient costs — historical orders used whatever recipe/cost was active
        when they were placed, which may differ from this if either has changed since.
      </p>
    </div>
  );
}
