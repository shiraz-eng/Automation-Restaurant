'use client';

import { AlertTriangle, Printer } from 'lucide-react';
import { ageMinutes, formatElapsed, orderTypeLabel, primaryAction, tableNumberLabel, type Kot, type Lane } from '../kitchenTypes';

const BORDER: Record<Lane, string> = {
  new: 'border-border',
  preparing: 'border-warn/50',
  ready: 'border-ok/50',
  delayed: 'border-danger/60',
  completed: 'border-border',
};
const HEADER_BG: Record<Lane, string> = {
  new: 'bg-surface',
  preparing: 'bg-warn/10',
  ready: 'bg-ok/10',
  delayed: 'bg-danger/10',
  completed: 'bg-surface',
};

export function KotCard({
  kot,
  lane,
  selected,
  canEdit,
  busy,
  onAdvanceLine,
  onPrimaryAction,
  onSelect,
  onPrint,
}: {
  kot: Kot;
  lane: Lane;
  selected: boolean;
  canEdit: boolean;
  busy: boolean;
  onAdvanceLine: (lineId: string, next: 'preparing' | 'ready' | 'served') => void;
  onPrimaryAction: () => void;
  onSelect: () => void;
  onPrint: () => void;
}) {
  const mins = ageMinutes(kot.created_at);
  const action = primaryAction(kot);

  return (
    <div
      onClick={onSelect}
      className={`rounded-lg border-2 ${BORDER[lane]} bg-surface overflow-hidden cursor-pointer transition-colors ${
        selected ? 'ring-2 ring-primary ring-offset-2 ring-offset-main' : ''
      }`}
    >
      <div className={`flex items-center justify-between px-3 py-2 ${HEADER_BG[lane]} border-b border-border`}>
        {/* The whole card opens the ticket for the mouse; this button does it for the keyboard. */}
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onSelect();
          }}
          aria-pressed={selected}
          aria-label={`KOT ${kot.order_number}, ${lane === 'new' ? 'new' : lane}, waiting ${formatElapsed(mins)}. Show ticket details`}
          className="rounded text-start font-black text-sm hover:underline"
        >
          KOT #{kot.order_number}{' '}
          <span className={`font-semibold ${lane === 'delayed' ? 'text-danger' : 'text-muted'}`}>
            ({lane === 'new' ? 'NEW' : lane.toUpperCase()}){lane === 'delayed' ? ' ⚠' : ''}
          </span>
        </button>
        <button
          onClick={(e) => {
            e.stopPropagation();
            onPrint();
          }}
          className="text-muted hover:text-body"
          aria-label={`Print KOT ${kot.order_number}`}
        >
          <Printer size={14} aria-hidden />
        </button>
      </div>

      <div className="px-3 py-2 border-b border-border/60 text-[0.6875rem] text-muted flex items-center justify-between">
        <span>
          ORDER #{kot.order_number} · {orderTypeLabel(kot.channel).toUpperCase()}
          {kot.table_label ? ` · TABLE ${tableNumberLabel(kot.table_label)}` : ''}
        </span>
        <span className={`font-bold tabular-nums ${lane === 'delayed' ? 'text-danger' : ''}`}>Waiting {formatElapsed(mins)}</span>
      </div>

      <div className="p-3 space-y-2">
        {kot.order_lines.map((l) => {
          const done = l.kds_status === 'served';
          const next = l.kds_status === 'queued' ? 'preparing' : l.kds_status === 'preparing' ? 'ready' : l.kds_status === 'ready' ? 'served' : null;
          return (
            <button
              key={l.id}
              disabled={!canEdit || !next || busy}
              onClick={(e) => {
                e.stopPropagation();
                if (next) onAdvanceLine(l.id, next);
              }}
              className={`w-full text-start rounded border px-2.5 py-1.5 transition-colors ${
                done ? 'opacity-40 border-border/60' : 'border-border hover:border-primary'
              }`}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="font-bold text-sm truncate">
                  {l.qty} × {l.name_snapshot}
                </span>
                <span
                  className={`text-[0.625rem] font-bold uppercase shrink-0 ${
                    l.kds_status === 'ready' || l.kds_status === 'served' ? 'text-ok' : l.kds_status === 'preparing' ? 'text-warn' : 'text-muted'
                  }`}
                >
                  {l.kds_status}
                </span>
              </div>
              {l.variant_name_snapshot && <div className="text-muted text-[0.6875rem] mt-0.5">{l.variant_name_snapshot}</div>}
              {l.modifiers && l.modifiers.length > 0 && <div className="text-muted text-[0.6875rem]">{l.modifiers.map((m) => m.name).join(', ')}</div>}
              {l.customer_note && (
                <div className="flex items-center gap-1 text-warn text-[0.6875rem] font-semibold mt-0.5">
                  <AlertTriangle size={11} /> {l.customer_note}
                </div>
              )}
            </button>
          );
        })}
      </div>

      {kot.customer_note && (
        <div className="mx-3 mb-2 flex items-center gap-1.5 rounded bg-warn/10 border border-warn/30 px-2.5 py-1.5 text-warn text-xs font-semibold">
          <AlertTriangle size={12} /> {kot.customer_note}
        </div>
      )}

      {canEdit && action && (
        <div className="p-3 pt-0">
          <button
            onClick={(e) => {
              e.stopPropagation();
              onPrimaryAction();
            }}
            disabled={busy}
            className="w-full rounded-md bg-primary text-primary-fg font-black text-xs py-2.5 uppercase tracking-wide disabled:opacity-50 active:scale-[0.99] transition-transform"
          >
            [ {action.label} ]
          </button>
        </div>
      )}
    </div>
  );
}
