'use client';

export function StationFilter({
  stations,
  counts,
  active,
  onPick,
}: {
  stations: string[];
  counts: Record<string, number>;
  active: string;
  onPick: (s: string) => void;
}) {
  if (stations.length === 0) return null;
  const total = Object.values(counts).reduce((s, n) => s + n, 0);
  return (
    <div className="flex gap-1.5 overflow-x-auto no-scrollbar">
      <Pill active={active === 'all'} onClick={() => onPick('all')}>
        All (Active) <Count n={total} />
      </Pill>
      {stations.map((s) => (
        <Pill key={s} active={active === s} onClick={() => onPick(s)}>
          {s} <Count n={counts[s] ?? 0} />
        </Pill>
      ))}
    </div>
  );
}

function Count({ n }: { n: number }) {
  return <span className="opacity-70 tabular-nums">{n} Active</span>;
}

function Pill({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`shrink-0 flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[11px] font-bold whitespace-nowrap transition-colors ${
        active ? 'bg-primary text-primary-fg' : 'bg-surface border border-border text-body hover:border-primary/40'
      }`}
    >
      {children}
    </button>
  );
}
