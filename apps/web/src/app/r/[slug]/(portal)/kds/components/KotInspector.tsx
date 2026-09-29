'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { X, Printer, AlertTriangle } from 'lucide-react';
import { usePortalSupabase } from '@/components/PortalProvider';
import { formatDateTime } from '@/lib/format';
import { orderTypeLabel, stationsForKot, tableNumberLabel, type Kot, type RecipeComponentRow } from '../kitchenTypes';

type AuditRow = { action: string; created_at: string; actor_email: string | null };

const STEP_LABEL: Record<string, string> = {
  'kitchen.start': 'Started preparing',
  'kitchen.ready': 'Marked ready',
  'kitchen.complete': 'Completed',
};

function one<T>(x: T | T[] | null): T | null {
  return Array.isArray(x) ? (x[0] ?? null) : x;
}

export function KotInspector({
  slug,
  kot,
  recipeComponents,
  onClose,
  onPrint,
}: {
  slug: string;
  kot: Kot;
  recipeComponents: RecipeComponentRow[];
  onClose: () => void;
  onPrint?: () => void;
}) {
  const supabase = usePortalSupabase();
  const [events, setEvents] = useState<AuditRow[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    setEvents(null);
    supabase
      .from('audit_logs')
      .select('action, created_at, actor_email')
      .eq('entity', 'orders')
      .eq('entity_id', kot.id)
      .in('action', ['kitchen.start', 'kitchen.ready', 'kitchen.complete'])
      .order('created_at', { ascending: true })
      .then(({ data }) => {
        if (!cancelled) setEvents((data as AuditRow[] | null) ?? []);
      });
    return () => {
      cancelled = true;
    };
  }, [supabase, kot.id]);

  const ingredients = kot.order_lines.flatMap((line) => {
    if (!line.menu_item_id) return [];
    // Base (non-variant-specific) recipe components only — the same
    // simplification the Menu editor's own recipe summary already makes.
    const comps = recipeComponents.filter((c) => c.menu_item_id === line.menu_item_id && c.variant_id === null);
    return comps.map((c) => {
      const ing = one(c.inventory_items);
      return { name: ing?.name ?? '—', unit: ing?.unit ?? '', qty: c.qty_per_unit * line.qty };
    });
  });
  const ingredientTotals = new Map<string, { unit: string; qty: number }>();
  for (const i of ingredients) {
    const cur = ingredientTotals.get(i.name) ?? { unit: i.unit, qty: 0 };
    cur.qty += i.qty;
    ingredientTotals.set(i.name, cur);
  }

  return (
    <div className="rounded-lg border border-border bg-surface flex flex-col h-full">
      <div className="flex items-center justify-between px-4 py-3 border-b border-border">
        <h2 className="font-black text-sm">KOT &amp; Lifecycle Inspector</h2>
        <div className="flex items-center gap-1.5">
          {onPrint && (
            <button
              onClick={onPrint}
              className="text-muted hover:text-body p-1 rounded hover:bg-surface border border-transparent hover:border-border transition-colors"
              title="Print KOT Ticket"
              aria-label="Print KOT Ticket"
            >
              <Printer size={15} />
            </button>
          )}
          <button onClick={onClose} className="text-muted hover:text-body p-1" aria-label="Close">
            <X size={15} />
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-5">
        <section>
          <h3 className="text-[10px] font-bold uppercase tracking-wide text-muted mb-2">KOT #{kot.order_number} Details</h3>
          <ol className="space-y-2 border-l border-border pl-3">
            <li className="text-xs">
              <span className="font-semibold">Order received</span>
              <div className="text-muted">{formatDateTime(kot.created_at)}</div>
            </li>
            {events === null ? (
              <li className="text-muted text-xs">Loading timeline…</li>
            ) : (
              events.map((e, i) => (
                <li key={i} className="text-xs">
                  <span className="font-semibold">{STEP_LABEL[e.action] ?? e.action}</span>
                  <div className="text-muted">{formatDateTime(e.created_at)}</div>
                </li>
              ))
            )}
          </ol>
        </section>

        <section>
          <h3 className="text-[10px] font-bold uppercase tracking-wide text-muted mb-2">This KOT Connects To</h3>
          <div className="rounded border border-border p-2.5 text-xs space-y-1">
            <div className="flex justify-between">
              <span className="text-muted">Order</span>
              <Link href={`/r/${slug}/orders`} className="text-primary font-semibold hover:underline">
                #{kot.order_number}
              </Link>
            </div>
            <div className="flex justify-between">
              <span className="text-muted">Type</span>
              <span className="font-semibold capitalize">
                {orderTypeLabel(kot.channel)}
                {kot.table_label ? ` · Table ${tableNumberLabel(kot.table_label)}` : ''}
              </span>
            </div>
            {kot.customer_name && (
              <div className="flex justify-between">
                <span className="text-muted">Customer</span>
                <span className="font-semibold">{kot.customer_name}</span>
              </div>
            )}
            <div className="flex justify-between">
              <span className="text-muted">Station(s)</span>
              <span className="font-semibold">{stationsForKot(kot).join(', ')}</span>
            </div>
          </div>
        </section>

        <section>
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-[10px] font-bold uppercase tracking-wide text-muted">
              Ordered Items ({kot.order_lines.reduce((s, l) => s + l.qty, 0)})
            </h3>
            {onPrint && (
              <button
                type="button"
                onClick={onPrint}
                className="text-[11px] font-semibold text-primary hover:underline flex items-center gap-1"
                aria-label="Print KOT Ticket"
              >
                <Printer size={12} /> Print Ticket
              </button>
            )}
          </div>
          <div className="space-y-1.5">
            {kot.order_lines.map((l) => (
              <div key={l.id} className="rounded border border-border bg-main/40 p-2.5 text-xs">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-bold text-body">
                    {l.qty} × {l.name_snapshot}
                  </span>
                  <span
                    className={`text-[10px] font-bold uppercase shrink-0 px-1.5 py-0.5 rounded border ${
                      l.kds_status === 'ready' || l.kds_status === 'served'
                        ? 'bg-ok/10 text-ok border-ok/30'
                        : l.kds_status === 'preparing'
                          ? 'bg-warn/10 text-warn border-warn/30'
                          : 'bg-muted/10 text-muted border-border'
                    }`}
                  >
                    {l.kds_status}
                  </span>
                </div>
                {l.variant_name_snapshot && (
                  <div className="text-muted text-[11px] mt-0.5 font-medium uppercase">
                    {l.variant_name_snapshot}
                  </div>
                )}
                {l.modifiers && l.modifiers.length > 0 && (
                  <div className="text-muted text-[11px] mt-0.5">
                    {l.modifiers.map((m) => m.name).join(', ')}
                  </div>
                )}
                {l.customer_note && (
                  <div className="flex items-center gap-1 text-warn text-[11px] font-semibold mt-1">
                    <AlertTriangle size={11} /> {l.customer_note}
                  </div>
                )}
              </div>
            ))}
          </div>
          {kot.customer_note && (
            <div className="mt-2 flex items-center gap-1.5 rounded bg-warn/10 border border-warn/30 p-2 text-warn text-xs font-semibold">
              <AlertTriangle size={12} /> Note: {kot.customer_note}
            </div>
          )}
        </section>

        <section>
          <h3 className="text-[10px] font-bold uppercase tracking-wide text-muted mb-2">Ingredients This Order Consumes</h3>
          {ingredientTotals.size > 0 ? (
            <div className="space-y-1">
              {[...ingredientTotals.entries()].map(([name, v]) => (
                <div key={name} className="flex justify-between text-xs">
                  <span>{name}</span>
                  <span className="font-mono text-muted">
                    -{v.qty}
                    {v.unit}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-muted text-xs">No recipe configured for these items.</p>
          )}
          <Link href={`/r/${slug}/inventory`} className="text-primary text-xs font-semibold hover:underline mt-2 inline-block">
            View Inventory →
          </Link>
        </section>
      </div>
    </div>
  );
}
