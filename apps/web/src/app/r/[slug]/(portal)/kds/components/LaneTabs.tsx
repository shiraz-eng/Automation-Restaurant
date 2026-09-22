'use client';

import { LANE_LABEL, type Lane } from '../kitchenTypes';

const ORDER: Lane[] = ['new', 'preparing', 'ready', 'delayed', 'completed'];
const TONE: Record<Lane, string> = {
  new: 'text-body',
  preparing: 'text-warn',
  ready: 'text-ok',
  delayed: 'text-danger',
  completed: 'text-muted',
};

export function LaneTabs({ counts, active, onPick }: { counts: Record<Lane, number>; active: Lane; onPick: (l: Lane) => void }) {
  return (
    <div className="flex gap-1 overflow-x-auto no-scrollbar border-b border-border">
      {ORDER.map((lane) => {
        const isActive = active === lane;
        return (
          <button
            key={lane}
            onClick={() => onPick(lane)}
            className={`shrink-0 px-4 py-2.5 text-xs font-bold border-b-2 -mb-px transition-colors ${
              isActive ? `border-primary ${TONE[lane]}` : 'border-transparent text-muted hover:text-body'
            }`}
          >
            {LANE_LABEL[lane].toUpperCase()} <span className="tabular-nums opacity-70">({counts[lane]})</span>
          </button>
        );
      })}
    </div>
  );
}
