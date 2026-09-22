'use client';

export type SummaryStat = { label: string; value: number; tone?: 'ok' | 'danger' | 'primary' | 'warn' };

export function MenuSummary({ stats }: { stats: SummaryStat[] }) {
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2.5">
      {stats.map((s) => (
        <div key={s.label} className="rounded-lg border border-border bg-surface px-3.5 py-2.5">
          <div
            className={`text-lg font-black leading-none ${
              s.tone === 'ok'
                ? 'text-ok'
                : s.tone === 'danger'
                  ? 'text-danger'
                  : s.tone === 'warn'
                    ? 'text-warn'
                    : s.tone === 'primary'
                      ? 'text-primary'
                      : 'text-body'
            }`}
          >
            {s.value}
          </div>
          <div className="text-muted text-[11px] font-semibold mt-1">{s.label}</div>
        </div>
      ))}
    </div>
  );
}
