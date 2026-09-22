'use client';

import type { Category } from '../menuTypes';

export function MenuCategoryNav({
  categories,
  counts,
  activeId,
  onPick,
}: {
  categories: Category[];
  /** category id -> product count (already filtered by the other toolbar filters). "" = uncategorised. */
  counts: Record<string, number>;
  activeId: string;
  onPick: (id: string) => void;
}) {
  const totalCount = Object.values(counts).reduce((s, n) => s + n, 0);

  return (
    <div className="flex gap-1.5 overflow-x-auto no-scrollbar pb-0.5">
      <Pill active={activeId === 'all'} onClick={() => onPick('all')}>
        All <Count n={totalCount} />
      </Pill>
      {categories.map((c) => (
        <Pill key={c.id} active={activeId === c.id} onClick={() => onPick(c.id)}>
          {c.name} <Count n={counts[c.id] ?? 0} />
        </Pill>
      ))}
      {counts[''] > 0 && (
        <Pill active={activeId === 'uncategorised'} onClick={() => onPick('uncategorised')}>
          Uncategorised <Count n={counts['']} />
        </Pill>
      )}
    </div>
  );
}

function Count({ n }: { n: number }) {
  return <span className="opacity-60 tabular-nums">({n})</span>;
}

function Pill({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`shrink-0 px-3 py-1.5 rounded-full text-xs font-bold whitespace-nowrap transition-colors ${
        active ? 'bg-primary text-primary-fg' : 'bg-surface border border-border text-body hover:border-primary/40'
      }`}
    >
      {children}
    </button>
  );
}
